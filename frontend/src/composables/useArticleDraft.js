import { ref, onBeforeUnmount } from 'vue'
import {
  readDraft,
  writeDraft,
  removeDraft,
  removeDraftIfCurrent,
  getStorageKey,
  isDraftEmpty,
  DraftConflictError,
  DraftStorageError
} from '../utils/draftStorage'

// Statuses:
//   idle       - nothing to save yet (blank editor)
//   saved      - last auto-save succeeded
//   error      - last auto-save failed (storage unavailable, etc.)
//   conflict   - a newer draft exists (another tab, recovered externally)
export function useArticleDraft(draftKeyRef, getFormData) {
  const status = ref('idle')
  const lastSavedAt = ref(null)
  const errorMessage = ref('')
  const version = ref(null)
  const hydrated = ref(false)
  // A newer draft seen via conflict or a cross-tab storage event.
  const remoteDraft = ref(null)

  let saveTimer = null

  function draftKey() {
    return typeof draftKeyRef === 'function'
      ? draftKeyRef()
      : draftKeyRef.value
  }

  function persist({ force = false } = {}) {
    const data = { ...getFormData() }

    // Blank editor: drop our own draft instead of storing noise.
    if (isDraftEmpty(data)) {
      if (version.value == null) {
        status.value = 'idle'
        return { ok: true, removed: true }
      }
      const existing = readDraft(draftKey())
      const storedVersion = Number.isInteger(existing?.version) ? existing.version : 0
      if (existing && storedVersion > (version.value || 0)) {
        // Never let an empty form erase a newer draft from another tab.
        status.value = 'conflict'
        remoteDraft.value = existing
        errorMessage.value =
          '检测到另一个标签页或窗口中保存了更新的草稿，为避免覆盖较新内容，本次自动保存已暂停。'
        return { ok: false, conflict: true }
      }
      removeDraftIfCurrent(draftKey(), version.value)
      version.value = null
      lastSavedAt.value = null
      status.value = 'idle'
      errorMessage.value = ''
      remoteDraft.value = null
      return { ok: true, removed: true }
    }

    try {
      const record = writeDraft(draftKey(), data, {
        force,
        baseVersion: version.value
      })
      version.value = record.version
      lastSavedAt.value = record.savedAt
      status.value = 'saved'
      errorMessage.value = ''
      remoteDraft.value = null
      return { ok: true, record }
    } catch (err) {
      remoteDraft.value = null
      if (err instanceof DraftConflictError) {
        status.value = 'conflict'
        remoteDraft.value = err.existing || null
        errorMessage.value =
          '检测到另一个标签页或窗口中保存了更新的草稿，为避免覆盖较新内容，本次自动保存已暂停。'
      } else if (err instanceof DraftStorageError) {
        status.value = 'error'
        errorMessage.value =
          '本地草稿写入失败（可能是存储空间不足或浏览器禁用了本地存储），请重试。'
      } else {
        status.value = 'error'
        errorMessage.value = err?.message || '自动保存失败，请重试。'
      }
      return { ok: false, error: err }
    }
  }

  function clearTimer() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }

  // Debounced auto-save triggered by form changes.
  function scheduleSave(delay = 1000) {
    if (!hydrated.value) return
    // Keep using the on-screen form while a conflict is unresolved.
    if (status.value === 'conflict') return
    clearTimer()
    saveTimer = setTimeout(() => {
      saveTimer = null
      persist()
    }, delay)
  }

  // Flush pending changes before the page is hidden/unloaded.
  function flushPending() {
    if (!saveTimer) return
    clearTimer()
    persist()
  }

  // Manual "retry" entry from the status bar.
  function retrySave() {
    if (status.value === 'conflict') return
    return persist()
  }

  // "Save my version anyway" entry after a conflict.
  function forcePersist() {
    return persist({ force: true })
  }

  function useRemoteDraft() {
    const draft = readDraft(draftKey())
    if (draft) {
      version.value = draft.version
      lastSavedAt.value = draft.savedAt
      status.value = 'saved'
      errorMessage.value = ''
      remoteDraft.value = null
      return draft
    }
    remoteDraft.value = null
    return null
  }

  function markHydrated(currentDraft = null) {
    hydrated.value = true
    if (currentDraft) {
      version.value = currentDraft.version
      lastSavedAt.value = currentDraft.savedAt
      status.value = 'saved'
    }
  }

  function discard() {
    removeDraft(draftKey())
    version.value = null
    lastSavedAt.value = null
    status.value = 'idle'
    errorMessage.value = ''
    remoteDraft.value = null
    clearTimer()
  }

  // Drop this draft after a successful publish, but keep it if a newer
  // version was saved elsewhere meanwhile.
  function clearAfterPublish() {
    const kept = !removeDraftIfCurrent(draftKey(), version.value)
    version.value = null
    lastSavedAt.value = null
    clearTimer()
    return !kept
  }

  // Cross-tab update notification: pause saving so the newer draft is not
  // overwritten.
  function handleStorage(event) {
    if (!hydrated.value) return
    if (event.key !== getStorageKey(draftKey())) return

    let current = null
    try {
      current = event.newValue ? JSON.parse(event.newValue) : null
    } catch {
      current = null
    }

    if (current && Number.isInteger(current.version) && current.version > (version.value || 0)) {
      status.value = 'conflict'
      remoteDraft.value = current
      errorMessage.value =
        '检测到另一个标签页或窗口中保存了更新的草稿，为避免覆盖较新内容，本次自动保存已暂停。'
      clearTimer()
    } else if (!current) {
      // Draft removed elsewhere.
      version.value = null
      lastSavedAt.value = null
      status.value = 'idle'
      remoteDraft.value = null
      errorMessage.value = ''
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') flushPending()
  }

  function handleBeforeUnload() {
    flushPending()
  }

  window.addEventListener('storage', handleStorage)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('beforeunload', handleBeforeUnload)

  onBeforeUnmount(() => {
    // Best effort: persist anything still pending when navigating inside the SPA.
    flushPending()
    clearTimer()
    window.removeEventListener('storage', handleStorage)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('beforeunload', handleBeforeUnload)
  })

  return {
    status,
    lastSavedAt,
    errorMessage,
    version,
    hydrated,
    remoteDraft,
    scheduleSave,
    flushPending,
    retrySave,
    forcePersist,
    useRemoteDraft,
    markHydrated,
    discard,
    clearAfterPublish
  }
}
