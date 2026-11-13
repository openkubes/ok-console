// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { expect, it } from 'vitest'

type Resource = {
  kind: string
  data?: Record<string, string>
  spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name: string, value?: string }> }> } } }
}

it('every rendered local-access overlay permits its configured audit method in each migration', { timeout: 30_000 }, async () => {
  const root = new URL('./overlays/', import.meta.url)
  const checked: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = new URL(`${entry.name}/`, root)
    if (!(await readdir(path)).includes('kustomization.yaml')) continue
    const rendered = execFileSync('kubectl', ['kustomize', path.pathname], { encoding: 'utf8' })
    const resources: Resource[] = JSON.parse(execFileSync('python3', ['-c',
      'import json, sys, yaml; json.dump(list(yaml.safe_load_all(sys.stdin)), sys.stdout)',
    ], { input: rendered, encoding: 'utf8' }))
    const modes = resources.flatMap(resource => resource.spec?.template?.spec?.containers ?? [])
      .flatMap(container => container.env ?? []).filter(env => env.name === 'OK_CONSOLE_LOCAL_ACCESS_MODE')
    for (const { value } of modes) {
      expect(['disabled', 'bootstrap', 'breakglass'], entry.name).toContain(value)
      if (value === 'disabled') continue
      const method = value === 'bootstrap' ? 'Bootstrap' : 'BreakGlass'
      const migrations = resources.filter(resource => resource.kind === 'ConfigMap')
        .flatMap(resource => Object.entries(resource.data ?? {})).filter(([name]) => name.endsWith('.sql'))
      for (const [name, sql] of migrations) {
        // Scope SQL extraction to this table, so the sessions/local_access_audit CHECKs cannot satisfy it.
        const statements = sql.replace(/--[^\n]*/g, '').split(';')
          .filter(statement => /\b(?:CREATE|ALTER)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?ok_console\.authentication_audit\b/i.test(statement))
        for (const statement of statements) {
          const checks = [...statement.matchAll(/CHECK\s*\(\s*authentication_method\s+IN\s*\(([^)]+)\)\s*\)/gi)]
          expect(checks.length, `${entry.name}/${name}: explicit audit method CHECK`).toBeGreaterThan(0)
          for (const [, allowed] of checks) {
            expect([...allowed.matchAll(/'([^']+)'/g)].map(match => match[1]), `${entry.name}/${name}`).toContain(method)
          }
          checked.push(`${entry.name}/${name}`)
        }
      }
    }
  }
  // Positive inventory: accidental failure to discover inherited migrations must fail.
  expect(checked.sort()).toEqual([
    'ok-shared-bootstrap-recovery/005_authentication_audit.sql',
    'ok-shared-bootstrap-recovery/006_live_authentication_audit.sql',
    'ok-shared-breakglass/005_authentication_audit.sql',
    'ok-shared-breakglass/006_live_authentication_audit.sql',
    'ok-shared-live/005_authentication_audit.sql',
    'ok-shared-live/006_live_authentication_audit.sql',
  ])
})
