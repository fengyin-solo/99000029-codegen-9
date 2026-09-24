// Local draft storage for the article editor.
//
// Each draft carries a monotonically increasing `version` and an ISO
// `savedAt` timestamp. Writers must pass the version they have last seen
// (`baseVersion`); if a newer draft exists in storage the write is rejected
// with a DraftConflictError instead of silently overwriting it.

const STORAGE_PREFIX = 'blog_draft_'

export const NEW_ARTICLE_DRAFT_KEY = 'new'

export class DraftConflictError extends Error {
  constructor(existing) {
    super('检测到较新的草稿')
    this.name = 'DraftConflictError'
    this.code = 'DRAFT_CONFLICT'
    this.existing = existing
  }
}

export class DraftStorageError extends Error {
  constructor(cause) {
    super(cause?.message || '本地存储不可用')
    this.name = 'DraftStorageError'
    this.code = 'DRAFT_STORAGE_ERROR'
    this.cause = cause
  }
}

export function getStorageKey(draftKey) {
  return `${STORAGE_PREFIX}${draftKey}`
}

export function articleDraftKey(articleId) {
  return `article:${articleId}`
}

export function readDraft(draftKey) {
  try {
    const raw = window.localStorage.getItem(getStorageKey(draftKey))
    if (!raw) return null
    const draft = JSON.parse(raw)
    return draft && typeof draft === 'object' ? draft : null
  } catch {
    // Corrupted JSON or storage unavailable: treat as no draft.
    return null
  }
}

/**
 * Persist a draft. Throws DraftConflictError when a newer version exists
 * (unless `force` is true). Throws DraftStorageError when localStorage
 * cannot be written (quota exceeded, private mode, etc.).
 */
export function writeDraft(draftKey, data, options = {}) {
  const { force = false, baseVersion = null } = options
  const existing = readDraft(draftKey)
  const storedVersion = Number.isInteger(existing?.version) ? existing.version : 0

  if (!force && baseVersion != null && storedVersion > baseVersion) {
    throw new DraftConflictError(existing)
  }

  const record = {
    articleId: data.articleId ?? null,
    title: data.title ?? '',
    summary: data.summary ?? '',
    body: data.body ?? '',
    tagsInput: data.tagsInput ?? '',
    version: storedVersion + 1,
    savedAt: new Date().toISOString()
  }

  try {
    window.localStorage.setItem(getStorageKey(draftKey), JSON.stringify(record))
  } catch (err) {
    throw new DraftStorageError(err)
  }

  return record
}

export function removeDraft(draftKey) {
  try {
    window.localStorage.removeItem(getStorageKey(draftKey))
  } catch {
    // Ignore: removal is best effort.
  }
}

/**
 * Remove the draft only when no newer version than `knownVersion` exists.
 * Returns false when a newer draft was kept.
 */
export function removeDraftIfCurrent(draftKey, knownVersion) {
  const existing = readDraft(draftKey)
  const storedVersion = Number.isInteger(existing?.version) ? existing.version : 0
  if (existing && storedVersion > (knownVersion || 0)) {
    return false
  }
  removeDraft(draftKey)
  return true
}

export function normalizeTags(tagsInput) {
  return String(tagsInput || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

export function isDraftEmpty(draft) {
  if (!draft) return true
  return (
    !String(draft.title || '').trim() &&
    !String(draft.summary || '').trim() &&
    !String(draft.body || '').trim() &&
    !String(draft.tagsInput || '').trim()
  )
}

/**
 * Compare a local draft with the online article so the editor can tell
 * "unsaved local work" apart from "content already published".
 */
export function draftMatchesArticle(draft, article) {
  if (!draft || !article) return false

  const draftTags = normalizeTags(draft.tagsInput)
  const articleTags = Array.isArray(article.tags)
    ? article.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : []

  const tagsMatch =
    draftTags.length === articleTags.length &&
    draftTags.every((tag, index) => tag === articleTags[index])

  return (
    String(draft.title ?? '') === String(article.title ?? '') &&
    String(draft.body ?? '') === String(article.body ?? '') &&
    String(draft.summary ?? '') === String(article.summary ?? '') &&
    tagsMatch
  )
}

export function formatDraftTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}
