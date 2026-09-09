// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { createClusterDryRunHttpAdapter } from './adapters/createClusterDryRun.mjs'

describe('CreateCluster dry-run HTTP adapter', () => {
  it('sends an explicitly dry-run request and rejects unsafe responses', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ operation: 'CreateCluster', mutationAllowed: false, format: 'ok147-create-plan/v1' }), { status: 200 }))
    const adapter = createClusterDryRunHttpAdapter({ url: 'https://runner.example.test/dry-run', fetchImpl: fetcher })
    const result = await adapter({ contract: { apiVersion: 'clusters.openkubes.io/v1alpha1' }, identity: { id: 'user-arash' }, correlationId: 'corr-1' })
    expect(result.mutationAllowed).toBe(false)
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toMatchObject({ dryRun: true, actor: { id: 'user-arash' } })
  })

  it('rejects credentials and secret-like fields before network access', async () => {
    const fetcher = vi.fn()
    const adapter = createClusterDryRunHttpAdapter({ url: 'https://runner.example.test/dry-run', fetchImpl: fetcher })
    await expect(adapter({ contract: { password: 'never' }, identity: { id: 'user-arash' }, correlationId: 'corr-2' })).rejects.toThrow('forbidden field')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

