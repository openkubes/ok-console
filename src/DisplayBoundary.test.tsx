import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import App from './App'
import { consoleData } from './data/consoleData'
import { platformFixture } from './data/fixtures'
import type { ConsoleAuthClient } from './auth/authClient'

vi.mock('./data/consoleData', async importOriginal => ({
  ...await importOriginal<typeof import('./data/consoleData')>(), consoleDataMode: 'bff',
}))
const auth: ConsoleAuthClient = {
  mode: 'oidc', restoreSession: async () => ({ method: 'oidc', identity: 'UX Viewer', source: 'test', assurance: 'Federated', expiresIn: '1h' }),
  startOidc: vi.fn(), authenticateLocal: vi.fn(), logout: vi.fn(),
}
afterEach(() => vi.restoreAllMocks())

it('B3 newly loaded detail is neutral even when the snapshot has ordinary display values', async () => {
  const data = structuredClone(platformFixture)
  const detail = structuredClone(data.clusters[0])
  const withheld = 'Value withheld by the Console redaction boundary.'
  detail.profile = withheld; detail.provider = withheld; detail.region = withheld
  detail.contractVersion = withheld; detail.revision = withheld
  detail.lifecycle = [{ label: 'Loaded detail', state: 'Unknown', detail: withheld }]
  vi.spyOn(consoleData, 'getSnapshot').mockResolvedValue(data)
  vi.spyOn(consoleData, 'getCluster').mockResolvedValue(detail)
  window.history.replaceState(null, '', '#/clusters')
  render(<App auth={auth}/>)
  fireEvent.click(await screen.findByRole('button', { name: `Open ${detail.name}` }))
  await screen.findByText('Loaded detail')
  expect(document.documentElement.textContent).not.toContain('redaction boundary')
  for (const el of document.querySelectorAll('*')) for (const attr of el.attributes) expect(attr.value).not.toContain('redaction boundary')
})
