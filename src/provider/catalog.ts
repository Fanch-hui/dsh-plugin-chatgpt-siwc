import { LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'
import { checkResponse } from './errors.js'
import { modelCapabilities, record, type CatalogModel } from './model-capabilities.js'

export type { CatalogModel } from './model-capabilities.js'

export async function fetchCatalog(accessToken: string, signal?: AbortSignal, fetcher = fetch): Promise<CatalogModel[]> {
  const response = await fetcher('https://api.openai.com/v1/models', {
    headers: { ...attributionHeaders(), authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal,
  })
  await checkResponse(response)
  return decodeCatalog(await response.json())
}

export function decodeCatalog(value: unknown): CatalogModel[] {
  const models = record(value)?.models
  if (!Array.isArray(models)) throw new LlmError('ChatGPT 模型目录格式错误。', 'SIWC_INVALID_CATALOG')
  const result: CatalogModel[] = []
  for (const value of models) {
    const item = record(value)
    if (!item || item.visibility !== 'list') continue
    if (typeof item.slug !== 'string' || !item.slug || item.slug !== item.slug.trim() ||
      typeof item.display_name !== 'string' || !item.display_name.trim()) {
      throw new LlmError('ChatGPT 模型目录缺少模型标识。', 'SIWC_INVALID_CATALOG')
    }
    result.push({ provider: 'chatgpt-siwc', id: item.slug, name: item.display_name, ...modelCapabilities(item) })
  }
  return result
}
