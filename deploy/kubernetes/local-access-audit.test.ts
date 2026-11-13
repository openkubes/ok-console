// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { expect, it } from 'vitest'

type Resource = {
  kind: string
  data?: Record<string, string>
  spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name: string, value?: string }> }> } } }
}

// A deliberately bounded SQL grammar: unfamiliar table statements or relevant CHECK
// expressions fail closed so new migrations must extend this parser explicitly.
const auditStatements = (sql: string, method: string, context: string) => {
  const tokens = sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[^\s]/g) ?? []
  const statements: string[][] = [[]]
  for (const token of tokens) {
    if (token.startsWith('--') || token.startsWith('/*')) continue
    if (token === ';') statements.push([])
    else statements.at(-1)!.push(token)
  }
  let tables = 0
  for (const statement of statements) {
    const words = statement.map(token => token.startsWith('"') ? token.slice(1, -1) : token)
    if (!words.some(token => /\bauthentication_audit\b/i.test(token))) continue
    const text = words.join(' ')
    const table = '(?:[a-z_][a-z_0-9]* \\. )?authentication_audit'
    const ddl = new RegExp(`^(?:CREATE TABLE (?:IF NOT EXISTS )?|ALTER TABLE (?:IF EXISTS )?(?:ONLY )?)${table} (?=\\(|ADD |DROP |ALTER )`, 'i')
    if (!ddl.test(text)) {
      // These statements cannot introduce a table CHECK. Anything else needs review.
      const metadata = new RegExp(`^(?:CREATE INDEX (?:IF NOT EXISTS )?[a-z_][a-z_0-9]* ON ${table} \\(|COMMENT ON TABLE ${table} IS '|REVOKE ALL ON TABLE ${table} FROM |GRANT INSERT ON TABLE ${table} TO )`, 'i')
      expect(metadata.test(text), `${context}: unparsed audit statement: ${text}`).toBe(true)
      continue
    }
    tables++
    let methodChecks = 0
    for (let i = 0; i < words.length; i++) {
      if (words[i].toUpperCase() !== 'CHECK') continue
      expect(words[++i], context).toBe('(')
      let depth = 1
      const expression: string[] = []
      while (++i < words.length && depth) {
        if (words[i] === '(') depth++
        if (words[i] === ')') depth--
        if (depth) expression.push(words[i])
      }
      expect(depth, `${context}: unterminated CHECK`).toBe(0)
      i--
      for (const column of ['authentication_method', 'cause']) {
        if (!expression.some(token => token.toLowerCase() === column)) continue
        if (column === 'authentication_method') methodChecks++
        const body = expression.join(' ')
        const membership = new RegExp(`^${column} IN \\( ('.*') \\)$`, 'i').exec(body)
        const length = new RegExp(`^length \\( ${column} \\) BETWEEN ([0-9]+) AND ([0-9]+)$`, 'i').exec(body)
        expect(Boolean(membership || length), `${context}: unsupported ${column} CHECK: ${body}`).toBe(true)
        const required = column === 'authentication_method' ? [method] : ['ORIGIN_REJECTED', 'CONTENT_TYPE_REJECTED', 'REQUEST_INVALID']
        for (const value of required) {
          if (membership) {
            expect(membership[1], context).toMatch(/^'(?:''|[^'])*'(?: , '(?:''|[^'])*')*$/)
            expect([...membership[1].matchAll(/'((?:''|[^'])*)'/g)].map(match => match[1].replaceAll("''", "'")), `${context}: ${column}`).toContain(value)
          } else {
            expect(value.length, `${context}: ${column} lower bound`).toBeGreaterThanOrEqual(Number(length![1]))
            expect(value.length, `${context}: ${column} upper bound`).toBeLessThanOrEqual(Number(length![2]))
          }
        }
      }
    }
    if (/^CREATE TABLE/i.test(text)) expect(methodChecks, `${context}: explicit audit method CHECK`).toBeGreaterThan(0)
  }
  return tables
}

it.each([
  'CREATE TABLE', 'CREATE TABLE IF NOT EXISTS', 'ALTER TABLE', 'ALTER TABLE IF EXISTS', 'ALTER TABLE ONLY', 'ALTER TABLE IF EXISTS ONLY',
])('parses %s with quoted/unquoted, qualified/unqualified audit tables', prefix => {
  for (const table of ['authentication_audit', 'ok_console.authentication_audit', '"authentication_audit"', '"ok_console"."authentication_audit"']) {
    const check = `CHECK ("authentication_method" IN ('Bootstrap', 'BreakGlass'))`
    const suffix = prefix.startsWith('CREATE') ? `(authentication_method text ${check})` : `ADD CONSTRAINT methods ${check}`
    expect(auditStatements(`${prefix} ${table} ${suffix};`, 'BreakGlass', prefix)).toBe(1)
  }
})
it.each([
  "ALTER TABLE IF EXISTS ok_console.authentication_audit ADD CONSTRAINT methods CHECK (authentication_method IN ('OIDC'));",
  "ALTER TABLE IF EXISTS ONLY \"authentication_audit\" ADD CONSTRAINT causes CHECK (cause IN ('ORIGIN_REJECTED', 'CONTENT_TYPE_REJECTED'));",
  'ALTER TABLE authentication_audit ADD CHECK (length(cause) BETWEEN 1 AND 12);',
  'ALTER TABLE authentication_audit ADD CHECK (cause <> \'REQUEST_INVALID\');',
  'DO $$ BEGIN ALTER TABLE authentication_audit ADD CHECK (false); END $$;',
  `DO $$ BEGIN EXECUTE 'ALTER TABLE authentication_audit ADD CHECK (false)'; END $$;`,
])('rejects restrictive or unparsed audit SQL: %s', sql => {
  expect(() => auditStatements(sql, 'BreakGlass', 'negative SQL')).toThrow()
})
it('allows every pre-verifier cause in every cause CHECK', () => {
  expect(auditStatements(`ALTER TABLE authentication_audit ADD CHECK (cause IN ('ORIGIN_REJECTED', 'CONTENT_TYPE_REJECTED', 'REQUEST_INVALID')), ADD CHECK (length(cause) BETWEEN 1 AND 64);`, 'Bootstrap', 'positive SQL')).toBe(1)
})

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
        if (auditStatements(sql, method, `${entry.name}/${name}`)) checked.push(`${entry.name}/${name}`)
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
