<template>
  <div class="article-editor">
    <div class="page-header">
      <h2 class="page-title">{{ isEdit ? '编辑文章' : '新建文章' }}</h2>
      <el-space>
        <el-button @click="goBack">取消</el-button>
        <el-button
          type="primary"
          :loading="saving"
          :disabled="draftStatus === 'conflict'"
          @click="handleSave"
        >
          保存
        </el-button>
      </el-space>
    </div>

    <!-- Auto-save status -->
    <div class="draft-status">
      <template v-if="draftStatus === 'saved'">
        <el-icon class="status-ok"><CircleCheck /></el-icon>
        <span>草稿已自动保存{{ draftLastSavedAt ? `（${formatDraftTime(draftLastSavedAt)}）` : '' }}</span>
        <el-button link type="primary" size="small" @click="handleDiscardDraft">
          删除草稿
        </el-button>
      </template>
      <template v-else-if="draftStatus === 'error'">
        <el-icon class="status-error"><CircleClose /></el-icon>
        <span class="status-error-text">{{ draftErrorMessage }}</span>
        <el-button link type="primary" size="small" @click="retrySave">
          重试保存
        </el-button>
      </template>
      <template v-else-if="draftStatus === 'conflict'">
        <el-icon class="status-warn"><Warning /></el-icon>
        <span class="status-warn-text">{{ draftErrorMessage }}</span>
        <el-button link type="primary" size="small" @click="handleUseRemoteDraft">
          载入较新草稿
        </el-button>
        <el-popconfirm
          title="确定保留并保存当前页面的内容吗？较新的草稿将被覆盖。"
          confirm-button-text="确定覆盖"
          cancel-button-text="取消"
          @confirm="forcePersist"
        >
          <template #reference>
            <el-button link type="warning" size="small">仍保存当前内容</el-button>
          </template>
        </el-popconfirm>
      </template>
      <template v-else>
        <el-icon><Document /></el-icon>
        <span class="status-muted">
          输入内容后将自动保存草稿（标题、摘要、标签、正文）
        </span>
      </template>
    </div>

    <!-- Unresolved recovered draft -->
    <el-alert
      v-if="pendingDraft"
      :closable="false"
      type="info"
      show-icon
      class="draft-alert"
    >
      <template #title>
        <span>
          本地有一份{{ isEdit ? '尚未发布' : '' }}的草稿（保存于
          {{ formatDraftTime(pendingDraft.savedAt) }}）尚未处理
        </span>
      </template>
      <div class="alert-actions">
        <el-button size="small" type="primary" @click="restorePendingDraft">
          恢复草稿
        </el-button>
        <el-button size="small" @click="discardPendingDraft">
          放弃草稿{{ isEdit ? '、使用线上内容' : '' }}
        </el-button>
      </div>
    </el-alert>

    <!-- Online article unavailable (offline on edit page) -->
    <el-alert
      v-if="fetchError"
      :closable="false"
      type="warning"
      show-icon
      class="draft-alert"
    >
      <template #title>
        <span>{{ fetchError }}</span>
      </template>
      <div class="alert-actions">
        <el-button size="small" type="primary" :loading="loading" @click="retryFetchArticle">
          重试获取线上内容
        </el-button>
      </div>
    </el-alert>

    <!-- Publish failure -->
    <el-alert
      v-if="publishError"
      :closable="false"
      type="error"
      show-icon
      class="draft-alert"
    >
      <template #title>
        <span>{{ publishError }}</span>
      </template>
      <div class="alert-actions">
        <el-button size="small" type="primary" :loading="saving" @click="handleSave">
          重新保存文章
        </el-button>
      </div>
    </el-alert>

    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="80px"
      v-loading="loading"
    >
      <el-form-item label="标题" prop="title">
        <el-input v-model="form.title" placeholder="请输入文章标题" size="large" />
      </el-form-item>

      <el-form-item label="摘要" prop="summary">
        <el-input
          v-model="form.summary"
          type="textarea"
          :rows="3"
          placeholder="请输入文章摘要"
        />
      </el-form-item>

      <el-form-item label="标签" prop="tags">
        <el-input
          v-model="form.tagsInput"
          placeholder="请输入标签，用逗号分隔"
        />
      </el-form-item>

      <el-form-item label="正文" prop="body">
        <el-tabs v-model="activeTab">
          <el-tab-pane label="编辑" name="edit">
            <el-input
              v-model="form.body"
              type="textarea"
              :rows="20"
              placeholder="请输入 Markdown 格式的文章正文"
              class="markdown-editor"
            />
          </el-tab-pane>
          <el-tab-pane label="分屏" name="split">
            <div class="split-pane">
              <el-input
                v-model="form.body"
                type="textarea"
                :rows="20"
                placeholder="请输入 Markdown 格式的文章正文"
                class="markdown-editor split-editor"
              />
              <div class="preview-content split-preview" v-html="renderedContent"></div>
            </div>
          </el-tab-pane>
          <el-tab-pane label="预览" name="preview">
            <div class="preview-content" v-html="renderedContent"></div>
          </el-tab-pane>
        </el-tabs>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, nextTick, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import {
  CircleCheck,
  CircleClose,
  Warning,
  Document
} from '@element-plus/icons-vue'
import { marked } from 'marked'
import api from '../../api'
import { useArticleDraft } from '../../composables/useArticleDraft'
import {
  readDraft,
  NEW_ARTICLE_DRAFT_KEY,
  articleDraftKey,
  draftMatchesArticle,
  formatDraftTime,
  isDraftEmpty,
  normalizeTags
} from '../../utils/draftStorage'

const route = useRoute()
const router = useRouter()

const formRef = ref(null)
const loading = ref(false)
const saving = ref(false)
const activeTab = ref('edit')
const pendingDraft = ref(null)
const publishError = ref('')
const fetchError = ref('')
let suppressAutoSave = false

const isEdit = computed(() => !!route.params.id)
const draftKey = computed(() =>
  isEdit.value
    ? articleDraftKey(route.params.id)
    : NEW_ARTICLE_DRAFT_KEY
)

const form = reactive({
  title: '',
  body: '',
  summary: '',
  tagsInput: ''
})

const rules = {
  title: [
    { required: true, message: '请输入文章标题', trigger: 'blur' }
  ],
  body: [
    { required: true, message: '请输入文章正文', trigger: 'blur' }
  ]
}

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true
})

// Preview is derived directly from form.body, so it stays in sync on
// every keystroke in edit / split / preview tabs.
const renderedContent = computed(() => {
  if (!form.body) return '<p>暂无内容</p>'
  return marked(form.body)
})

const {
  status: draftStatus,
  lastSavedAt: draftLastSavedAt,
  errorMessage: draftErrorMessage,
  scheduleSave,
  retrySave,
  forcePersist,
  useRemoteDraft,
  markHydrated,
  discard,
  clearAfterPublish
} = useArticleDraft(draftKey, () => ({
  articleId: isEdit.value ? Number(route.params.id) : null,
  title: form.title,
  summary: form.summary,
  body: form.body,
  tagsInput: form.tagsInput
}))

// Auto-save title / summary / tags / body shortly after they change.
watch(
  () => [form.title, form.summary, form.tagsInput, form.body],
  () => {
    publishError.value = ''
    // Ignore programmatic fills (loading online content / restoring).
    if (suppressAutoSave) return
    // Wait until the recovery choice (restore / discard) is made.
    if (pendingDraft.value) return
    scheduleSave()
  }
)

onMounted(() => {
  if (isEdit.value) {
    fetchArticle()
  } else {
    initNewDraft()
  }
})

function fillForm(data) {
  form.title = data.title || ''
  form.body = data.body || ''
  form.summary = data.summary || ''
  form.tagsInput = data.tagsInput ?? (Array.isArray(data.tags) ? data.tags.join(', ') : '')
}

// Fill the form without triggering an auto-save round-trip.
async function applyFormData(data) {
  suppressAutoSave = true
  fillForm(data)
  await nextTick()
  suppressAutoSave = false
}

function initNewDraft() {
  const draft = readDraft(draftKey.value)
  if (draft && !isDraftEmpty(draft)) {
    pendingDraft.value = draft
    markHydrated()
    offerRecovery(draft, null)
  } else {
    markHydrated()
  }
}

async function fetchArticle() {
  loading.value = true
  fetchError.value = ''
  try {
    const response = await api.get(`/articles/${route.params.id}`)
    const article = response.data
    await applyFormData(article)

    const draft = readDraft(draftKey.value)
    if (draft && !draftMatchesArticle(draft, article)) {
      // Local unsaved work that differs from the online article.
      pendingDraft.value = draft
      markHydrated()
      offerRecovery(draft, article)
    } else {
      // No draft, or a draft merely mirroring the online content.
      if (draft) discard()
      markHydrated()
    }
  } catch (error) {
    console.error('Failed to fetch article:', error)
    const draft = readDraft(draftKey.value)
    if (draft && !isDraftEmpty(draft)) {
      // Offline / server error: keep editing from the local draft and
      // provide an explicit way back to the online content.
      await applyFormData(draft)
      markHydrated(draft)
      const reason = isNetworkError(error)
        ? '网络异常，无法获取线上文章。已载入本地草稿，你可以继续编辑（修改仍会自动保存）。'
        : '获取线上文章失败。已载入本地草稿，你可以继续编辑（修改仍会自动保存）。'
      fetchError.value = reason
      ElMessage.warning(reason)
    } else {
      ElMessage.error('获取文章失败，且没有可恢复的本地草稿')
      router.push('/admin/articles')
    }
  } finally {
    loading.value = false
  }
}

async function retryFetchArticle() {
  loading.value = true
  fetchError.value = ''
  try {
    const response = await api.get(`/articles/${route.params.id}`)
    const article = response.data
    const draft = readDraft(draftKey.value)

    if (draft && !draftMatchesArticle(draft, article)) {
      // Local edits exist: let the user choose again instead of overwriting.
      await applyFormData(article)
      pendingDraft.value = draft
      markHydrated()
      offerRecovery(draft, article)
    } else {
      await applyFormData(article)
      if (draft) discard()
      markHydrated()
    }
    ElMessage.success('已获取最新线上内容')
  } catch (error) {
    console.error('Failed to fetch article:', error)
    fetchError.value = isNetworkError(error)
      ? '网络仍然异常，无法获取线上文章。本地草稿不受影响，可继续编辑。'
      : '获取线上文章失败，请稍后重试。'
  } finally {
    loading.value = false
  }
}

function restoreMessageNode(draft, article = null) {
  const lines = [
    h('p', { style: 'margin: 0 0 8px; line-height: 1.6;' }, [
      h('strong', null, '检测到本地保存的未发布草稿'),
      h(
        'span',
        { style: 'color: #606266; margin-left: 8px;' },
        `保存于 ${formatDraftTime(draft.savedAt)}`
      )
    ]),
    h(
      'p',
      { style: 'margin: 0 0 8px; color: #606266; line-height: 1.6;' },
      draft.title?.trim()
        ? `草稿标题：${draft.title}`
        : '草稿尚未填写标题'
    )
  ]
  if (article) {
    lines.push(
      h(
        'p',
        { style: 'margin: 0 0 8px; color: #909399; line-height: 1.6;' },
        `线上内容最后更新于 ${formatDraftTime(article.updated_at)}，恢复草稿不会影响线上文章。`
      )
    )
  } else {
    lines.push(
      h(
        'p',
        { style: 'margin: 0 0 8px; color: #909399; line-height: 1.6;' },
        '可以恢复草稿继续编辑，或放弃后从空白内容开始。'
      )
    )
  }
  return h('div', null, lines)
}

// Show the recovery dialog once the online article has been loaded.
async function offerRecovery(draft, article = null) {
  try {
    await ElMessageBox({
      title: isEdit.value ? '发现本地未发布草稿' : '发现未完成的文章草稿',
      message: restoreMessageNode(draft, article),
      confirmButtonText: '恢复草稿',
      cancelButtonText: isEdit.value ? '使用线上内容' : '放弃草稿',
      distinguishCancelAndClose: true,
      closeOnClickModal: false,
      type: 'info'
    })
    restorePendingDraft()
  } catch (action) {
    if (action === 'cancel') {
      discardPendingDraft()
    }
    // Closing via the X leaves the draft untouched and the inline banner
    // offers the same choices again.
  }
}

async function restorePendingDraft() {
  const draft = pendingDraft.value
  if (!draft) return
  await applyFormData(draft)
  pendingDraft.value = null
  markHydrated(draft)
  ElMessage.success('已恢复本地草稿')
}

function discardPendingDraft() {
  pendingDraft.value = null
  discard()
  ElMessage.success('草稿已放弃')
}

function handleDiscardDraft() {
  ElMessageBox.confirm('确定删除当前本地草稿吗？此操作不影响已发布的文章。', '删除草稿', {
    confirmButtonText: '删除',
    cancelButtonText: '取消',
    type: 'warning'
  })
    .then(() => {
      discard()
      ElMessage.success('草稿已删除')
    })
    .catch(() => {})
}

async function handleUseRemoteDraft() {
  const draft = useRemoteDraft()
  if (!draft) {
    ElMessage.warning('未找到较新的草稿')
    return
  }
  await applyFormData(draft)
  ElMessage.success('已载入较新的草稿')
}

function isNetworkError(error) {
  return !error.response && (error.code === 'ERR_NETWORK' || error.message === 'Network Error')
}

async function handleSave() {
  if (!formRef.value || saving.value) return
  // Prevent overwriting a newer local draft via publish flow.
  if (draftStatus.value === 'conflict') {
    ElMessage.warning('请先处理较新的草稿（载入或选择覆盖）')
    return
  }

  try {
    await formRef.value.validate()
  } catch {
    return
  }

  saving.value = true
  publishError.value = ''
  try {
    // Parse tags from comma-separated input
    const tags = normalizeTags(form.tagsInput)

    const articleData = {
      title: form.title,
      body: form.body,
      summary: form.summary,
      tags
    }

    if (isEdit.value) {
      await api.put(`/articles/${route.params.id}`, articleData)
      ElMessage.success('文章已更新')
    } else {
      await api.post('/articles', articleData)
      ElMessage.success('文章已创建')
    }

    clearAfterPublish()
    router.push('/admin/articles')
  } catch (error) {
    console.error('Failed to save article:', error)
    let message
    if (isNetworkError(error)) {
      message = '网络异常，文章保存失败（断网或无法连接服务器）。内容已保留为本地草稿，网络恢复后可重试。'
    } else if (error.code === 'ECONNABORTED') {
      message = '保存文章超时，请检查网络后重试。内容已保留为本地草稿。'
    } else {
      message = error.response?.data?.error || '保存文章失败，请重试。内容已保留为本地草稿。'
    }
    publishError.value = message
    ElNotification.error({
      title: '保存失败',
      message: isNetworkError(error) ? '当前可能处于离线状态，请检查网络连接后重试。' : message,
      duration: 4000
    })
    // Make sure the current content is captured as a draft.
    scheduleSave(0)
  } finally {
    saving.value = false
  }
}

function goBack() {
  // Existing cancel flow: simply return. Any pending edits are flushed
  // into the local draft by the composable's unmount hook.
  router.push('/admin/articles')
}
</script>

<style scoped>
.article-editor {
  padding-top: 20px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.page-title {
  font-size: 24px;
  color: #303133;
  margin: 0;
}

.draft-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  margin-bottom: 12px;
  padding: 4px 12px;
  font-size: 13px;
  color: #606266;
  background-color: #f4f4f5;
  border-radius: 4px;
}

.draft-status .status-ok {
  color: #67c23a;
}

.draft-status .status-error,
.draft-status .status-error-text {
  color: #f56c6c;
}

.draft-status .status-warn,
.draft-status .status-warn-text {
  color: #e6a23c;
}

.draft-status .status-muted {
  color: #909399;
}

.draft-alert {
  margin-bottom: 16px;
}

.alert-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}

.markdown-editor :deep(textarea) {
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  font-size: 14px;
}

.split-pane {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.split-editor {
  min-width: 0;
}

.split-preview {
  max-height: 462px;
  min-height: 462px;
}

.preview-content {
  padding: 16px;
  background-color: #fff;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  min-height: 400px;
  max-height: 600px;
  overflow-y: auto;
}

.preview-content :deep(h1) {
  font-size: 24px;
  margin: 16px 0;
}

.preview-content :deep(h2) {
  font-size: 20px;
  margin: 14px 0;
}

.preview-content :deep(h3) {
  font-size: 18px;
  margin: 12px 0;
}

.preview-content :deep(pre) {
  background-color: #f5f7fa;
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
}

.preview-content :deep(code) {
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  font-size: 14px;
}

.preview-content :deep(p) {
  margin-bottom: 12px;
}
</style>
