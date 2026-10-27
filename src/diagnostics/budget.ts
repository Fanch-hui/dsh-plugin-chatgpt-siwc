/** Bound synchronous observation work before canonical serialization copies request data. */
export const fingerprintByteLimit = 4 * 1024 * 1024
const nodeLimit = 16_384
const depthLimit = 64

export function withinFingerprintBudget(value: unknown): boolean {
  let remaining = fingerprintByteLimit
  let nodes = nodeLimit
  const take = (bytes: number): boolean => (remaining -= bytes) >= 0
  const string = (text: string): boolean => {
    if (text.length + 2 > remaining || !take(2)) return false
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      let bytes = 3
      if (code === 34 || code === 92) bytes = 2
      else if (code < 32) bytes = [8, 9, 10, 12, 13].includes(code) ? 2 : 6
      else if (code < 128) bytes = 1
      else if (code < 2048) bytes = 2
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) { bytes = 4; index++ }
        else bytes = 6
      } else if (code >= 0xdc00 && code <= 0xdfff) bytes = 6
      if (!take(bytes)) return false
    }
    return true
  }
  const visit = (item: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > depthLimit) return false
    if (typeof item === 'string') return string(item)
    if (item === null || typeof item !== 'object') return take(24)
    if (!take(2)) return false
    if (Array.isArray(item)) {
      if (item.length > nodes) return false
      for (const child of item) if (!take(1) || !visit(child, depth + 1)) return false
      return true
    }
    for (const property in item) {
      if (!Object.hasOwn(item, property)) continue
      if (!take(2) || !string(property) || !visit((item as Record<string, unknown>)[property], depth + 1)) return false
    }
    return true
  }
  return visit(value, 0)
}
