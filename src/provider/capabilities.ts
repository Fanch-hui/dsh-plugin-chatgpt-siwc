import type { CapabilityEntry, CapabilityStatus } from '../storage/accounts.js'
import { ProviderError } from './errors.js'

export type { CapabilityEntry, CapabilityStatus }
export type ProviderCapability = 'prompt_cache_options' | 'configuration_update' | 'additional_tools'

export const CAPABILITY_PROJECTION_VERSION = 2
export const PROVIDER_CAPABILITIES: readonly ProviderCapability[] = [
  'prompt_cache_options',
  'configuration_update',
  'additional_tools',
]

/** Only paths from the body sent on this attempt are eligible for capability attribution. */
export interface CapabilityProbe {
  capability: ProviderCapability
  parameters: readonly string[]
}

/** Retain capability names and structural paths, never prompt content or tool schemas. */
export function requestCapabilityProbes(body: Record<string, unknown>): CapabilityProbe[] {
  const probes: CapabilityProbe[] = []
  const options = body.prompt_cache_options
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    const fields = options as Record<string, unknown>
    probes.push({
      capability: 'prompt_cache_options',
      parameters: ['prompt_cache_options', ...['mode', 'ttl', 'comparison_response_id']
        .filter(field => fields[field] !== undefined).map(field => `prompt_cache_options.${field}`)],
    })
  }
  const input = Array.isArray(body.input) ? body.input : []
  for (const capability of ['configuration_update', 'additional_tools'] as const) {
    const parameters: string[] = []
    input.forEach((item: unknown, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
        (item as Record<string, unknown>).type !== capability) return
      // An invalid nested tool schema or reasoning value does not reject the item type.
      parameters.push(`input.${index}`, `input.${index}.type`)
    })
    if (parameters.length) probes.push({capability, parameters})
  }
  return probes
}

const STRICT_PARAMETER_CODES = new Set([
  'unknown_parameter',
  'unsupported_parameter',
  'unsupported_value',
  'unrecognized_request_argument',
])

export function isUnsupportedParameterError(
  error: unknown,
  capability?: ProviderCapability,
  probes: readonly CapabilityProbe[] = [],
): boolean {
  if (!error || typeof error !== 'object') return false
  const raw = error as Record<string, unknown>
  const code = typeof raw.providerCode === 'string' ? raw.providerCode : raw.code
  const param = raw.param
  const status = error instanceof ProviderError ? error.failure.status : raw.status
  if (error instanceof ProviderError && (error.code === 'QUOTA' || error.code === 'AUTH')) return false
  if (typeof status === 'number' && (status === 401 || status === 403 || status === 429 || status >= 500)) return false
  if (typeof code !== 'string' || !STRICT_PARAMETER_CODES.has(code) || typeof param !== 'string') return false
  if (!capability) return true
  const normalized = param.replace(/\[(\d+)\]/g, '.$1')
  return probes.some(probe => probe.capability === capability && probe.parameters.includes(normalized))
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityEntry>()

  private key(replayScope: string, model: string, capability: ProviderCapability): string {
    return `${replayScope}\0${model}\0${capability}`
  }

  get(
    replayScope: string,
    model: string,
    capability: ProviderCapability,
    projectionVersion = CAPABILITY_PROJECTION_VERSION,
  ): CapabilityEntry {
    const saved = this.entries.get(this.key(replayScope, model, capability))
    if (saved && saved.projectionVersion === projectionVersion) return saved
    return { status: 'unknown', probedAt: 0, projectionVersion }
  }

  status(
    replayScope: string,
    model: string,
    capability: ProviderCapability,
    projectionVersion = CAPABILITY_PROJECTION_VERSION,
  ): CapabilityStatus {
    return this.get(replayScope, model, capability, projectionVersion).status
  }

  isSupported(replayScope: string, model: string, capability: ProviderCapability): boolean {
    return this.status(replayScope, model, capability) === 'supported'
  }

  isAllowed(replayScope: string, model: string, capability: ProviderCapability): boolean {
    return this.status(replayScope, model, capability) !== 'unsupported'
  }

  record(
    replayScope: string,
    model: string,
    capability: ProviderCapability,
    status: CapabilityStatus,
    probedAt = Date.now(),
    projectionVersion = CAPABILITY_PROJECTION_VERSION,
  ): CapabilityEntry {
    const entry: CapabilityEntry = { status, probedAt, projectionVersion }
    this.entries.set(this.key(replayScope, model, capability), entry)
    return entry
  }

  recordError(
    replayScope: string,
    model: string,
    capability: ProviderCapability,
    error: unknown,
    probes: readonly CapabilityProbe[] = [],
    probedAt = Date.now(),
    projectionVersion = CAPABILITY_PROJECTION_VERSION,
  ): boolean {
    if (!isUnsupportedParameterError(error, capability, probes)) return false
    this.record(replayScope, model, capability, 'unsupported', probedAt, projectionVersion)
    return true
  }

  selectProbeCandidate(
    replayScope: string,
    model: string,
    candidates: readonly ProviderCapability[] = PROVIDER_CAPABILITIES,
  ): ProviderCapability | undefined {
    return candidates.find(capability => this.status(replayScope, model, capability) === 'unknown')
  }

  hydrate(replayScope: string, capabilities?: Record<string, Record<string, CapabilityEntry>>): void {
    if (!capabilities) return
    for (const [model, perModel] of Object.entries(capabilities)) {
      for (const capability of PROVIDER_CAPABILITIES) {
        const entry = perModel?.[capability]
        if (entry) this.entries.set(this.key(replayScope, model, capability), entry)
      }
    }
  }

  invalidateScope(replayScope: string): void {
    const prefix = `${replayScope}\0`
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}
