// Official stable text models, checked against api-docs.deepseek.com on 2026-09-05.
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const DEEPSEEK_MODELS = [
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
] as const
export const DEFAULT_DEEPSEEK_MODEL = DEEPSEEK_MODELS[0].value
export const DEEPSEEK_EFFORTS = [
  { value: 'none', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'high', label: '高（默认）' },
  { value: 'max', label: '最高' },
] as const

export function isDeepSeekBaseUrl(value: string) {
  try {
    const url = new URL(value)
    return (
      url.origin === DEEPSEEK_BASE_URL &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ['', '/v1', '/chat/completions', '/v1/chat/completions'].includes(
        url.pathname.replace(/\/+$/, ''),
      )
    )
  } catch {
    return false
  }
}
