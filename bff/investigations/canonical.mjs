import { createHash } from 'node:crypto'

// Canonical JSON (sorted keys, no whitespace) so a digest depends only on content, not on formatting.
export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const sha256Digest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`

// RFC 6901 JSON pointer. Returns { found, value }; never throws.
export const resolvePointer = (document, pointer) => {
  if (pointer === '') return { found: true, value: document }
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return { found: false }
  let current = document
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/.test(token) && Number(token) < current.length) current = current[Number(token)]
    else if (current && typeof current === 'object' && !Array.isArray(current) && Object.hasOwn(current, token)) current = current[token]
    else return { found: false }
  }
  return { found: true, value: current }
}

// Fact reference as in the platform-diagnostics 1.2.0 draft (`fact_refs`): "<evidence_id>#<json-pointer>".
export const parseFactRef = (factRef) => {
  const match = typeof factRef === 'string' ? /^([a-z0-9][a-z0-9-]{0,62})#(\/.*)$/.exec(factRef) : null
  return match ? { evidenceId: match[1], pointer: match[2] } : null
}
