import { Pool } from 'pg'
import { createSessionRuntime } from '../security/runtime.mjs'

// Real runtime authorizer and store; only mounted configuration is supplied in memory.
export const createDiagnosticRuntime = (port, options = {}) => createSessionRuntime({
  env: {
    OK_CONSOLE_SESSION_STORE_MODE: 'postgres', OK_CONSOLE_ORIGIN: 'https://console.invalid',
    OK_CONSOLE_ENVIRONMENT_ID: 'community-preview', OK_CONSOLE_TENANT_ID: 'platform',
    OK_CONSOLE_SESSION_EPOCH: 'epoch-test', OK_CONSOLE_AUTHORIZATION_REVISION: 'revision',
    OK_CONSOLE_POSTGRES_URL_FILE: '/fixture/database', OK_CONSOLE_POSTGRES_ALLOW_INSECURE_LOOPBACK: 'true',
    OK_CONSOLE_SESSION_ENVELOPE_PRIMARY_KEY_ID: 'key', OK_CONSOLE_SESSION_ENVELOPE_KEYS_FILE: '/fixture/keys',
    OK_CONSOLE_POSTGRES_STATEMENT_TIMEOUT_MS: '250', OK_CONSOLE_POSTGRES_QUERY_TIMEOUT_MS: '600',
    OK_CONSOLE_POSTGRES_CONNECT_TIMEOUT_MS: '500',
  },
  fileReader: async path => Buffer.from(path === '/fixture/database' ? `postgresql://postgres@127.0.0.1:${port}/postgres` : JSON.stringify({ key: Buffer.alloc(32, 7).toString('base64') })),
  poolFactory: config => new Pool({ ...config, ...options }),
})
