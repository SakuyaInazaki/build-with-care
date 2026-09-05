import { useState } from 'react'
import { Check, ChevronRight, CircleDot, ShieldCheck, Wifi } from 'lucide-react'
import type { ModelConfig, PublicSettings } from '../../../decision-desk/shared/types.js'
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_EFFORTS,
  DEEPSEEK_MODELS,
  DEFAULT_DEEPSEEK_MODEL,
  isDeepSeekBaseUrl,
} from '../../../decision-desk/shared/model-presets.js'
import { api } from '../lib/api.js'
import { Dialog, Spinner } from './ui.js'

type Role = 'worker' | 'reviewer'
const roles: Role[] = ['worker', 'reviewer']
const roleLabel = (role: Role) => (role === 'worker' ? '执行模型' : '审查模型')
const presetModel = (model: string) => DEEPSEEK_MODELS.some((entry) => entry.value === model)
const initialProvider = (settings: PublicSettings) =>
  roles.every(
    (role) =>
      !settings[role].baseUrl ||
      (isDeepSeekBaseUrl(settings[role].baseUrl) && settings[role].family === 'deepseek'),
  ) &&
  (!roles.some((role) => settings[role].hasKey) ||
    (settings.sharedDeepSeekKey && roles.every((role) => presetModel(settings[role].model))))
    ? 'deepseek'
    : 'custom'
const draftFrom = (settings: PublicSettings) => ({
  worker: { ...settings.worker, apiKey: '' },
  reviewer: { ...settings.reviewer, apiKey: '' },
})
const selectionFrom = (settings: PublicSettings) => ({
  worker: presetModel(settings.worker.model) ? settings.worker.model : DEFAULT_DEEPSEEK_MODEL,
  reviewer: presetModel(settings.reviewer.model) ? settings.reviewer.model : DEFAULT_DEEPSEEK_MODEL,
})
const effortFrom = (settings: PublicSettings) => ({
  worker: settings.worker.reasoningEffort ?? 'high',
  reviewer: settings.reviewer.reasoningEffort ?? 'high',
})

export function Settings({
  settings,
  onSave,
  onClose,
}: {
  settings: PublicSettings
  onSave: (settings: PublicSettings) => void
  onClose: () => void
}) {
  const [provider, setProvider] = useState(initialProvider(settings))
  const [models, setModels] = useState(draftFrom(settings))
  const [deepseekKey, setDeepseekKey] = useState('')
  const [selections, setSelections] = useState(selectionFrom(settings))
  const [efforts, setEfforts] = useState(effortFrom(settings))
  const [reviewSeconds, setReviewSeconds] = useState(settings.reviewTimeoutMs / 1000)
  const [gateMinutes, setGateMinutes] = useState(settings.gateTimeoutMs / 60000)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [testRole, setTestRole] = useState<Role | null>(null)
  const clean = (role: Role): ModelConfig =>
    provider === 'deepseek'
      ? {
          baseUrl: DEEPSEEK_BASE_URL,
          model: selections[role],
          family: 'deepseek',
          apiKey: deepseekKey.trim(),
          reasoningEffort: efforts[role],
        }
      : {
          baseUrl: models[role].baseUrl.trim(),
          model: models[role].model.trim(),
          family: models[role].family.trim(),
          apiKey: models[role].apiKey.trim(),
        }
  const canRetainCustomKey = (role: Role) =>
    settings[role].hasKey &&
    (settings[role].baseUrl === models[role].baseUrl.trim() ||
      (isDeepSeekBaseUrl(settings[role].baseUrl) && isDeepSeekBaseUrl(models[role].baseUrl)))
  const canTest = (role: Role) => {
    if (provider === 'deepseek' && !settings.sharedDeepSeekKey) return false
    const draft = clean(role),
      saved = settings[role]
    return (
      !busy &&
      !testRole &&
      !draft.apiKey &&
      draft.model === saved.model &&
      draft.family === saved.family &&
      (provider !== 'deepseek' || draft.reasoningEffort === (saved.reasoningEffort ?? 'high')) &&
      (draft.baseUrl === saved.baseUrl ||
        (isDeepSeekBaseUrl(draft.baseUrl) && isDeepSeekBaseUrl(saved.baseUrl))) &&
      (saved.hasKey || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(saved.baseUrl))
    )
  }
  const changeProvider = (next: 'deepseek' | 'custom') => {
    setProvider(next)
    setError('')
    setMessage('')
  }
  const save = async () => {
    setError('')
    setMessage('')
    setBusy(true)
    try {
      if (provider === 'deepseek' && !deepseekKey.trim() && !settings.sharedDeepSeekKey)
        throw new Error('请输入 DeepSeek API 密钥。')
      const result = await api<PublicSettings>('/api/settings', {
        worker: clean('worker'),
        reviewer: clean('reviewer'),
        reviewTimeoutMs: Math.round(reviewSeconds * 1000),
        gateTimeoutMs: Math.round(gateMinutes * 60000),
      })
      onSave(result)
      setModels(draftFrom(result))
      setDeepseekKey('')
      setSelections(selectionFrom(result))
      setEfforts(effortFrom(result))
      setMessage('设置已保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '设置未保存。')
    } finally {
      setBusy(false)
    }
  }
  const test = async (role: Role) => {
    setTestRole(role)
    setError('')
    setMessage('')
    try {
      await api<{ message: string }>('/api/settings/test', { role })
      setMessage('连接成功，服务已返回响应')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接失败。')
    } finally {
      setTestRole(null)
    }
  }
  const testButton = (role: Role) => (
    <button
      className="button secondary"
      type="button"
      disabled={!canTest(role)}
      title={canTest(role) ? '使用已保存的配置发送一次模型请求' : '保存配置后可测试'}
      onClick={() => void test(role)}
    >
      {testRole === role ? <Spinner /> : <Wifi size={15} />}测试连接
    </button>
  )
  return (
    <Dialog title="模型与设置" onClose={onClose} wide>
      <form
        className="modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <div className="provider-switch" role="group" aria-label="模型服务">
          <button
            type="button"
            aria-pressed={provider === 'deepseek'}
            disabled={busy || !!testRole}
            onClick={() => changeProvider('deepseek')}
          >
            DeepSeek
          </button>
          <button
            type="button"
            aria-pressed={provider === 'custom'}
            disabled={busy || !!testRole}
            onClick={() => changeProvider('custom')}
          >
            自定义服务
          </button>
        </div>
        {provider === 'deepseek' ? (
          <section aria-label="DeepSeek 配置" className="deepseek-config">
            <div className="shared-api-key">
              <label htmlFor="deepseek-api-key">API 密钥</label>
              <input
                id="deepseek-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={deepseekKey}
                placeholder={
                  settings.sharedDeepSeekKey ? '已设置，留空保留' : '输入 DeepSeek API 密钥'
                }
                required={!settings.sharedDeepSeekKey}
                onChange={(event) => {
                  setDeepseekKey(event.target.value)
                  setMessage('')
                }}
              />
            </div>
            <div className="settings-models">
              {roles.map((role) => (
                <section className="model-section" key={role} aria-label={roleLabel(role)}>
                  <div className="model-title">
                    {role === 'worker' ? <CircleDot size={21} /> : <ShieldCheck size={21} />}
                    <label htmlFor={`deepseek-${role}-model`}>{roleLabel(role)}</label>
                  </div>
                  <select
                    id={`deepseek-${role}-model`}
                    value={selections[role]}
                    onChange={(event) => {
                      setSelections({ ...selections, [role]: event.target.value })
                      setMessage('')
                    }}
                  >
                    {DEEPSEEK_MODELS.map((model) => (
                      <option value={model.value} key={model.value}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                  <label htmlFor={`deepseek-${role}-effort`}>{roleLabel(role)}推理强度</label>
                  <select
                    id={`deepseek-${role}-effort`}
                    value={efforts[role]}
                    onChange={(event) => {
                      setEfforts({
                        ...efforts,
                        [role]: event.target.value as NonNullable<ModelConfig['reasoningEffort']>,
                      })
                      setMessage('')
                    }}
                  >
                    {DEEPSEEK_EFFORTS.map((effort) => (
                      <option value={effort.value} key={effort.value}>
                        {effort.label}
                      </option>
                    ))}
                  </select>
                  {testButton(role)}
                </section>
              ))}
            </div>
          </section>
        ) : (
          <div className="settings-models custom-models">
            {roles.map((role) => (
              <section className="model-section" key={role} aria-label={roleLabel(role)}>
                <div className="model-title">
                  {role === 'worker' ? <CircleDot size={21} /> : <ShieldCheck size={21} />}
                  <h3>{roleLabel(role)}</h3>
                </div>
                {(
                  [
                    {
                      field: 'baseUrl',
                      label: '接口地址',
                      placeholder: 'https://api.example.com/v1',
                      type: 'url',
                    },
                    {
                      field: 'model',
                      label: '模型名称',
                      placeholder: '输入模型名称',
                      type: 'text',
                    },
                    {
                      field: 'family',
                      label: '模型来源',
                      placeholder: '输入服务商名称',
                      type: 'text',
                    },
                    {
                      field: 'apiKey',
                      label: 'API 密钥',
                      placeholder: canRetainCustomKey(role)
                        ? '已设置，留空保留'
                        : '输入此服务的 API 密钥',
                      type: 'password',
                    },
                  ] as const
                ).map(({ field, label, placeholder, type }) => (
                  <div key={field}>
                    <label htmlFor={`${role}-${field}`}>{label}</label>
                    <input
                      id={`${role}-${field}`}
                      type={type}
                      value={models[role][field]}
                      placeholder={placeholder}
                      autoComplete="off"
                      spellCheck={false}
                      required={field !== 'apiKey'}
                      onChange={(event) => {
                        setModels({
                          ...models,
                          [role]: { ...models[role], [field]: event.target.value },
                        })
                        setMessage('')
                      }}
                    />
                  </div>
                ))}
                {testButton(role)}
              </section>
            ))}
          </div>
        )}
        <details className="settings-advanced">
          <summary>
            <ChevronRight size={16} />
            等待设置
          </summary>
          <div className="settings-timing">
            <div>
              <label htmlFor="review-timeout">审查耗时提示（秒）</label>
              <input
                id="review-timeout"
                type="number"
                min={2}
                max={60}
                step={1}
                required
                value={reviewSeconds}
                onChange={(event) => setReviewSeconds(Number(event.target.value))}
              />
            </div>
            <div>
              <label htmlFor="gate-timeout">人工处理等待（分钟）</label>
              <input
                id="gate-timeout"
                type="number"
                min={1}
                max={60}
                step={1}
                required
                value={gateMinutes}
                onChange={(event) => setGateMinutes(Number(event.target.value))}
              />
            </div>
          </div>
        </details>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {message && (
          <p className="saved-note" role="status" aria-live="polite">
            <Check size={16} /> {message}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            完成
          </button>
          <button className="button primary" disabled={busy || !!testRole}>
            {busy ? <Spinner /> : <Check size={16} />}保存设置
          </button>
        </div>
      </form>
    </Dialog>
  )
}
