import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules() })
it.each([
  [true, 'true', '127.0.0.1', true],
  [true, 'true', 'localhost', true],
  [true, 'true', '[::1]', true],
  [false, 'true', '127.0.0.1', false],
  [true, '', '127.0.0.1', false],
  [true, 'false', '127.0.0.1', false],
  [true, 'true', 'console.example.org', false],
])('gates preview: dev=%s flag=%s host=%s', async (dev, flag, hostname, expected) => {
  vi.stubEnv('DEV', dev)
  vi.stubEnv('VITE_WJAX_KIND_PREVIEW', flag)
  vi.stubGlobal('window', { location: { hostname } })
  vi.resetModules()
  expect((await import('./localPreview')).wjaxLocalPreviewEnabled).toBe(expected)
})
