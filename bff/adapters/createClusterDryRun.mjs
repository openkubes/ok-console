const DEFAULT_TIMEOUT_MS = 5000

const forbidden = /(^|_)(access[_-]?token|bearer[_-]?token|client[_-]?secret|kubeconfig|password|private[_-]?key|refresh[_-]?token|secret|token)($|_)/i

const assertSafe = (value, path = '$') => {
  if (Array.isArray(value)) return value.forEach((item, index) => assertSafe(item, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (forbidden.test(key)) throw new Error(`dry-run payload contains forbidden field at ${path}.${key}`)
    assertSafe(nested, `${path}.${key}`)
  }
}

export const createClusterDryRunHttpAdapter = ({ url, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
  const endpoint = new URL(url)
  if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('OK_CONSOLE_DRY_RUN_URL must use HTTP(S).')
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('OK_CONSOLE_DRY_RUN_URL must not contain credentials or query parameters.')
  return async ({ contract, identity, correlationId }) => {
    assertSafe(contract)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ contract, actor: { id: identity.id }, correlationId, dryRun: true }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`dry-run runner returned HTTP ${response.status}`)
      const result = await response.json()
      assertSafe(result)
      if (result.mutationAllowed !== false || result.operation !== 'CreateCluster') throw new Error('dry-run runner returned an unsafe result')
      return result
    } finally {
      clearTimeout(timeout)
    }
  }
}

