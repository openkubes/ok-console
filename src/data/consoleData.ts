import type { ConsoleDataPort } from '../domain/contracts'
import { BffConsoleAdapter } from './bffAdapter'
import { FixtureConsoleAdapter } from './fixtureAdapter'

export type ConsoleDataMode = 'fixture' | 'bff'

export const consoleDataMode: ConsoleDataMode =
  import.meta.env.VITE_CONSOLE_DATA_MODE === 'bff' ? 'bff' : 'fixture'

if (import.meta.env.VITE_CONSOLE_AUTH_MODE === 'oidc' && consoleDataMode !== 'bff') {
  throw new Error('VITE_CONSOLE_AUTH_MODE=oidc requires VITE_CONSOLE_DATA_MODE=bff.')
}

export const createConsoleData = (mode: ConsoleDataMode): ConsoleDataPort =>
  mode === 'bff' ? new BffConsoleAdapter(import.meta.env.VITE_CONSOLE_BFF_URL || '/api/console/v0') : new FixtureConsoleAdapter()

export const consoleData = createConsoleData(consoleDataMode)
