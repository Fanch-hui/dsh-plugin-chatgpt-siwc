import { createHash } from 'node:crypto'
import { LlmError, type ToolSchema } from '@deepseek-ai/dsh-llm'

export interface ToolIdentity { original: string; namespace: string; name: string }

export function toolIdentity(original: string): ToolIdentity {
  const normalized = original.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'tool'
  const hash = createHash('sha256').update(original).digest('hex').slice(0, 16)
  return { original, namespace: 'dsh', name: `${normalized}_${hash}` }
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

function stableSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSchema)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareNames(a, b))
    .map(([key, child]) => [key, stableSchema(child)]))
}

export function projectTools(tools: readonly ToolSchema[] = []) {
  const ordered = [...tools].sort((a, b) => compareNames(a.name, b.name))
  const identities = ordered.map(tool => toolIdentity(tool.name))
  if (new Set(identities.map(tool => tool.original)).size !== tools.length) {
    throw new LlmError('DSH 工具名必须唯一。', 'SIWC_TOOL_NAME_COLLISION')
  }
  return {
    identities,
    tools: tools.length ? [{
      type: 'namespace', name: 'dsh', description: 'Tools provided by the DSH runtime.',
      tools: ordered.map((tool, i) => ({
        type: 'function', name: identities[i].name, description: tool.description,
        parameters: stableSchema(tool.parameters), strict: false,
      })),
    }] : [],
  }
}

export function resolveTool(identities: readonly ToolIdentity[], name: string, namespace?: string): ToolIdentity {
  const found = identities.find(tool => tool.name === name && tool.namespace === (namespace ?? 'dsh'))
  if (!found) throw new LlmError('ChatGPT 返回了当前请求未声明的工具。', 'SIWC_UNKNOWN_TOOL')
  return found
}
