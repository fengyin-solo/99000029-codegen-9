<template>
  <div class="article-editor">
    <div class="page-header">
      <div class="title-area">
        <h2 class="page-title">{{ isEdit ? '编辑文章' : '新建文章' }}</h2>
        <span v-if="draftStatusText" class="draft-status" :class="draftStatusClass">
          {{ draftStatusText }}
        </span>
      </div>
      <el-space>
        <el-button @click="goBack">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">
          保存
        </el-button>
      </el-space>
    </div>

    <el-alert
      v-if="!isOnline"
      type="warning"
      show-icon
      :closable="false"
      class="status-alert"
      title="当前网络已断开：内容会自动保存到本地草稿，恢复网络后请点击保存"
    />

    <el-alert
      v-if="saveError"
      type="error"
      show-icon
      class="status-alert"
      @close="saveError = ''"
    >
      <template #title>
        <div class="alert-with-action">
          <span>保存失败：{{ saveError }}（内容已保留在本地草稿中）</span>
          <el-button size="small" type="danger" plain :loading="saving" @click="retrySave">
            重试
          </el-button>
        </div>
      </template>
    </el-alert>

    <el-alert
      v-if="draftConflict"
      type="warning"
      show-icon
      :closable="false"
      class="status-alert"
      title="检测到其他窗口保存了更新的草稿，为避免覆盖，本页的自动保存已暂停"
    >
      <el-space class="alert-actions">
        <el-button size="small" @click="loadLatestDraft">加载最新草稿</el-button>
        <el-button size="small" @click="continueEditing">继续编辑当前内容</el-button>
      </el-space>
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
          <el-tab-pane label="预览" name="preview">
            <div class="preview-content" v-html="renderedContent"></div>
          </el-tab-pane>
        </el-tabs>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { marked } from 'marked'
import api from '../../api'

const route = useRoute()
const router = useRouter()

const formRef = ref(null)
const loading = ref(false)
const saving = ref(false)
const activeTab = ref('edit')

const isEdit = computed(() => !!route.params.id)

const form = reactive({
  title: '',
  body: '',
  summary: '',
  tagsInput: ''
})

// 基线内容：新建时为空，编辑时为线上内容，用于判断是否有未保存的修改
const baseline = reactive({
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

// 预览随正文变化实时更新
const renderedContent = computed(() => {
  if (!form.body) return '<p>暂无内容</p>'
  try {
    return marked(form.body)
  } catch (error) {
    console.error('Failed to render markdown:', error)
    return '<p>预览渲染失败</p>'
  }
})

// ---- 本地草稿自动保存 ----
const DRAFT_PREFIX = 'blog_draft_'
const DRAFT_PERSIST_DELAY = 800

const draftKey = computed(() =>
  isEdit.value ? `${DRAFT_PREFIX}edit_${route.params.id}` : `${DRAFT_PREFIX}new`
)

const lastEditAt = ref(0)       // 本页最后一次编辑时间
const draftSavedAt = ref(0)     // 草稿最近一次写入时间
const draftSaveFailed = ref(false)
const draftConflict = ref(false) // 其他窗口存在更新的草稿，暂停自动保存以避免覆盖
const serverUpdatedAt = ref('')
let persistTimer = null

const isDirty = computed(() =>
  form.title !== baseline.title ||
  form.body !== baseline.body ||
  form.summary !== baseline.summary ||
  form.tagsInput !== baseline.tagsInput
)

const draftStatusText = computed(() => {
  if (draftSaveFailed.value) return '草稿自动保存失败'
  if (draftConflict.value) return '检测到更新的草稿，自动保存已暂停'
  if (draftSavedAt.value) return `草稿已自动保存于 ${formatTime(draftSavedAt.value)}`
  if (isDirty.value) return '有未保存的修改'
  return ''
})

const draftStatusClass = computed(() => {
  if (draftSaveFailed.value) return 'is-error'
  if (draftConflict.value) return 'is-warning'
  return ''
})

watch(
  () => [form.title, form.body, form.summary, form.tagsInput],
  () => {
    lastEditAt.value = Date.now()
    schedulePersist()
  }
)

function schedulePersist() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(persistDraft, DRAFT_PERSIST_DELAY)
}

function readDraft() {
  try {
    const raw = localStorage.getItem(draftKey.value)
    return raw ? JSON.parse(raw) : null
  } catch (error) {
    console.error('Failed to read draft:', error)
    return null
  }
}

function removeDraft() {
  try {
    localStorage.removeItem(draftKey.value)
  } catch (error) {
    console.error('Failed to remove draft:', error)
  }
}

// 将当前表单写入本地草稿；若已存在更新的草稿（如其他窗口保存的）则不覆盖
function persistDraft() {
  if (!isDirty.value) return
  try {
    const existing = readDraft()
    if (existing && existing.updatedAt > lastEditAt.value) {
      draftConflict.value = true
      return
    }
    const draft = {
      articleId: isEdit.value ? Number(route.params.id) : null,
      title: form.title,
      summary: form.summary,
      tagsInput: form.tagsInput,
      body: form.body,
      updatedAt: lastEditAt.value
    }
    localStorage.setItem(draftKey.value, JSON.stringify(draft))
    draftSavedAt.value = lastEditAt.value
    draftSaveFailed.value = false
    draftConflict.value = false
  } catch (error) {
    console.error('Failed to persist draft:', error)
    draftSaveFailed.value = true
  }
}

// 立即把未写入的修改刷入草稿（保存失败、页面卸载等场景）
function flushDraft() {
  clearTimeout(persistTimer)
  persistDraft()
}

// ---- 草稿恢复 ----
function checkDraft() {
  const draft = readDraft()
  if (!draft) return

  const hasContent = !!(draft.title || draft.summary || draft.tagsInput || draft.body)
  if (!hasContent) {
    removeDraft()
    return
  }

  if (isEdit.value) {
    const sameAsOnline =
      (draft.title || '') === baseline.title &&
      (draft.summary || '') === baseline.summary &&
      (draft.tagsInput || '') === baseline.tagsInput &&
      (draft.body || '') === baseline.body
    if (sameAsOnline) {
      // 草稿与线上内容一致，无需恢复
      removeDraft()
      return
    }
    ElMessageBox.confirm(
      `检测到本地草稿（保存于 ${formatTime(draft.updatedAt)}），与线上内容（更新于 ${formatTime(serverUpdatedAt.value)}）不一致。`,
      '发现未保存的草稿',
      {
        confirmButtonText: '恢复本地草稿',
        cancelButtonText: '使用线上内容',
        distinguishCancelAndClose: true,
        type: 'warning'
      }
    ).then(() => {
      restoreDraft(draft)
    }).catch((action) => {
      // 直接关闭则保留草稿，下次进入时再提示
      if (action === 'cancel') {
        discardDraft()
      }
    })
  } else {
    const draftTitle = draft.title ? `「${draft.title}」` : ''
    ElMessageBox.confirm(
      `检测到上次未保存的草稿${draftTitle}（保存于 ${formatTime(draft.updatedAt)}）。`,
      '发现未保存的草稿',
      {
        confirmButtonText: '恢复草稿',
        cancelButtonText: '丢弃草稿',
        distinguishCancelAndClose: true,
        type: 'warning'
      }
    ).then(() => {
      restoreDraft(draft)
    }).catch((action) => {
      if (action === 'cancel') {
        discardDraft()
      }
    })
  }
}

function restoreDraft(draft) {
  form.title = draft.title || ''
  form.summary = draft.summary || ''
  form.tagsInput = draft.tagsInput || ''
  form.body = draft.body || ''
  ElMessage.success('已恢复本地草稿，内容尚未保存到服务器')
}

function discardDraft() {
  removeDraft()
  draftSavedAt.value = 0
  ElMessage.info('已丢弃本地草稿')
}

// ---- 草稿冲突处理（其他窗口存在更新的草稿） ----
function loadLatestDraft() {
  const draft = readDraft()
  draftConflict.value = false
  if (draft) {
    restoreDraft(draft)
  }
}

function continueEditing() {
  // 用户确认以当前内容为准，允许覆盖其他窗口保存的草稿
  draftConflict.value = false
  lastEditAt.value = Date.now()
  persistDraft()
}

// ---- 网络状态 ----
const isOnline = ref(navigator.onLine)
const saveError = ref('')

function handleOnline() {
  isOnline.value = true
  ElMessage.success('网络已恢复，可以重新保存')
}

function handleOffline() {
  isOnline.value = false
  ElMessage.warning('网络连接已断开，内容将仅保存在本地草稿')
}

function handleBeforeUnload() {
  flushDraft()
}

onMounted(async () => {
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  window.addEventListener('beforeunload', handleBeforeUnload)

  let loaded = true
  if (isEdit.value) {
    loaded = await fetchArticle()
  }
  if (loaded) {
    checkDraft()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
  window.removeEventListener('beforeunload', handleBeforeUnload)
  flushDraft()
})

async function fetchArticle() {
  loading.value = true
  try {
    const response = await api.get(`/articles/${route.params.id}`)
    const article = response.data
    form.title = article.title
    form.body = article.body
    form.summary = article.summary
    form.tagsInput = article.tags.join(', ')
    serverUpdatedAt.value = article.updated_at
    syncBaseline()
    return true
  } catch (error) {
    console.error('Failed to fetch article:', error)
    ElMessage.error('获取文章失败')
    router.push('/admin/articles')
    return false
  } finally {
    loading.value = false
  }
}

function syncBaseline() {
  baseline.title = form.title
  baseline.body = form.body
  baseline.summary = form.summary
  baseline.tagsInput = form.tagsInput
}

async function handleSave() {
  if (saving.value) return // 防止重复点击
  if (!formRef.value) return

  await formRef.value.validate((valid) => {
    if (valid) {
      submitSave()
    }
  })
}

async function submitSave() {
  if (saving.value) return

  saving.value = true
  saveError.value = ''
  try {
    // Parse tags from comma-separated input
    const tags = form.tagsInput
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0)

    const articleData = {
      title: form.title,
      body: form.body,
      summary: form.summary,
      tags: tags
    }

    if (isEdit.value) {
      await api.put(`/articles/${route.params.id}`, articleData)
      ElMessage.success('文章已更新')
    } else {
      await api.post('/articles', articleData)
      ElMessage.success('文章已创建')
    }

    removeDraft()
    syncBaseline()
    router.push('/admin/articles')
  } catch (error) {
    console.error('Failed to save article:', error)
    saveError.value = !navigator.onLine
      ? '网络连接已断开，请检查网络后重试'
      : (error.response?.data?.error || '保存文章失败，请稍后重试')
    ElMessage.error(saveError.value)
    flushDraft() // 立即写入本地草稿，防止内容丢失
  } finally {
    saving.value = false
  }
}

function retrySave() {
  submitSave()
}

function goBack() {
  router.push('/admin/articles')
}

function formatTime(value) {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知时间'
  return date.toLocaleString('zh-CN', { hour12: false })
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
  margin-bottom: 20px;
}

.title-area {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.page-title {
  font-size: 24px;
  color: #303133;
  margin: 0;
}

.draft-status {
  font-size: 12px;
  color: #909399;
}

.draft-status.is-warning {
  color: #e6a23c;
}

.draft-status.is-error {
  color: #f56c6c;
}

.status-alert {
  margin-bottom: 16px;
}

.alert-with-action {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.alert-actions {
  margin-top: 8px;
}

.markdown-editor :deep(textarea) {
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  font-size: 14px;
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
