// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20_000 })

const procedure = readFileSync(new URL('../../docs/evidence/ok-170/maintenance-procedure.md', import.meta.url), 'utf8')
const checkout = fileURLToPath(new URL('../../', import.meta.url))
const tool = fileURLToPath(new URL('./ok170-gates.mjs', import.meta.url))
const gateDigest = createHash('sha256').update(readFileSync(tool)).digest('hex')
const context = 'ok-shared-admin@ok-shared'
const namespace = 'openkubes-console'

type Command = { name: string; line: number; shell: string; setup: string[] }

const fence = /^ {0,3}(`{3,})([^\r\n]*)\r?\n([\s\S]*?)^ {0,3}\1[ \t]*(?=\r?$)/gm

function bashBlocks(markdown: string) {
  return [...markdown.matchAll(fence)].filter((block) => block[2].trim() === 'bash')
}

function commands(markdown: string) {
  const setup: string[] = []
  const invocations: Command[] = []
  for (const block of bashBlocks(markdown)) {
    const firstLine = markdown.slice(0, block.index).split('\n').length + 1
    const lines = block[3].split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = firstLine + i
      let shell = lines[i].trim()
      while (shell.endsWith('\\') && i + 1 < lines.length) shell += '\n' + lines[++i]
      if (/^(gate|k)\(\)\s*\{/.test(shell)) {
        while (!/(?:^|[;\n])\s*}\s*(?:#.*)?$/.test(shell) && i + 1 < lines.length) {
          shell += '\n' + lines[++i]
        }
        setup.push(shell)
      } else if (/^(export\s|GATE_SCRIPT=)/.test(shell)) {
        setup.push(shell)
      } else {
        // Inventory also calls k inside case arms such as "secrets) k ...".
        const invocation = /^(?:[^\s]+\)\s+)?((gate|k)(?=\s|$)[\s\S]*)$/.exec(shell)
        if (invocation) invocations.push({ name: invocation[2], line, shell: invocation[1], setup: [...setup] })
      }
    }
  }
  return invocations
}

function checkKuberc(markdown: string) {
  const [first] = commands(markdown)
  expect(first, 'procedure must document a gate or k invocation').toBeDefined()
  expect(first.setup, `export KUBECTL_KUBERC=false before the first gate or k invocation (line ${first.line})`)
    .toContainEqual(expect.stringMatching(/^export\s+KUBECTL_KUBERC=(?:false|"false"|'false')(?:\s+#.*)?$/))
}

function fixtureInputs(dir: string) {
  const releaseManager = 'ok-173-breakglass'
  const remainingManager = 'ok-172-live'
  const id = 'Service/observed-state-producer'
  const artifact = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'observed-state-producer', namespace } }
  const ownership = (manager: string) => ({ manager, operation: 'Apply' })
  const managed = (manager: string) => ({
    ...ownership(manager), apiVersion: 'v1', fieldsType: 'FieldsV1', fieldsV1: { 'f:spec': { 'f:selector': {} } },
  })
  const spec = { selector: { app: 'producer' }, ports: [{ port: 80 }] }
  const snapshot = (managers: string[]) => ({
    ...artifact, spec, metadata: {
      ...artifact.metadata, uid: 'fixture-uid', generation: 1, resourceVersion: '7', managedFields: managers.map(managed),
    },
  })
  const selected = (manager: string) => ({ [id]: { manager, paths: [['f:spec', 'f:selector']] } })
  const fixtures = {
    PRE_H_ALLOWLIST: { [id]: [ownership(remainingManager), ownership(releaseManager)] },
    POST_H_ALLOWLIST: { [id]: [ownership(remainingManager)] },
    PRE_H_SNAPSHOT: snapshot([remainingManager, releaseManager]),
    UNDO_SNAPSHOT: snapshot([remainingManager]),
    RELEASE_SELECTED: selected(remainingManager),
    UNDO_SELECTED: selected(releaseManager),
    HANDOVER_ARTIFACT: artifact,
    HANDOVER_UNDO_ARTIFACT: { ...artifact, spec },
  }
  return Object.fromEntries(Object.entries(fixtures).map(([variable, value]) => {
    const path = join(dir, `${variable}.json`)
    writeFileSync(path, JSON.stringify(value))
    return [variable, path]
  }))
}

function runShell(setup: string[], shell: string, dir: string, env: Record<string, string> = {}) {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', [...setup, shell].join('\n')], {
    cwd: dir, encoding: 'utf8', timeout: 5_000,
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, REVIEWED_CHECKOUT: checkout, GATE_SHA256: gateDigest, ...env },
  })
  if (result.error) throw result.error
  return result
}

function checkGateCommands(markdown: string) {
  const gates = commands(markdown).filter(({ name }) => name === 'gate')
  const found = gates.map(({ line, shell }) => `line ${line}: ${shell}`).join('\n')
  expect(gates.length, `expected 7 documented gate invocations, found ${gates.length}:\n${found || '(none)'}`).toBe(7)
  const dir = mkdtempSync(join(tmpdir(), 'ok170-procedure-'))
  try {
    const log = join(dir, 'calls.jsonl')
    writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ args, kuberc: process.env.KUBECTL_KUBERC }) + '\\n')
if (JSON.stringify(args.slice(5)) === JSON.stringify(['version', '--client', '-o', 'json'])) {
  process.stdout.write(JSON.stringify({ clientVersion: { gitVersion: 'v1.34.1' } }))
} else {
  process.exitCode = 1
}
`, { mode: 0o755 })
    const env = { ...fixtureInputs(dir), CALL_LOG: log }
    for (const gate of gates) {
      writeFileSync(log, '')
      const result = runShell(gate.setup, gate.shell, dir, env)
      const diagnostic = `line ${gate.line}: ${gate.shell}\n${result.stderr.trim()}`
      // The real CLI validates mode, flags and JSON inputs before calling kubectl.
      // Let the version check pass and stop at the first operation that would reach the server.
      expect(result.stderr.trim(), diagnostic).toBe('kubectl failed, stderr or empty stdout')
      expect(result.status, diagnostic).toBe(1)
      const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      expect(calls, diagnostic).toHaveLength(2)
      expect(calls[0].args.slice(5), diagnostic).toEqual(['version', '--client', '-o', 'json'])
      for (const call of calls) {
        expect(call.args.slice(0, 4), diagnostic).toEqual(['--context', context, '--namespace', namespace])
        expect(call.kuberc, diagnostic).toBe('false')
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function checkGateTarget(markdown: string, expectedStop?: string) {
  const gate = commands(markdown).find(({ name }) => name === 'gate')
  expect(gate, 'procedure must document a gate invocation').toBeDefined()
  const dir = mkdtempSync(join(tmpdir(), 'ok170-wrapper-'))
  try {
    const result = runShell(gate!.setup, [
      'node() { printf "%s\\n" "$@"; }',
      'kubectl() { echo "unexpected kubectl call"; }',
      'gate ownership-inventory',
    ].join('\n'), dir)
    if (expectedStop) {
      expect(result.stderr.trim()).toBe(expectedStop)
      expect(result.status).toBe(1)
      expect(result.stdout, 'node and kubectl must not run when the digest differs').toBe('')
      return
    }
    expect(result.status, result.stderr).toBe(0)
    const args = result.stdout.trimEnd().split('\n').slice(2)
    for (const [flag, value] of [['--context', context], ['--namespace', namespace]]) {
      const index = args.indexOf(flag)
      expect(args.slice(index, index + 2), `gate() must pass ${flag} ${value}`).toEqual([flag, value])
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function checkNonForced(markdown: string) {
  const blocks = [...markdown.matchAll(fence)]
  const prose = markdown.replaceAll(fence, '')
  const inlineCommands = [...prose.matchAll(/`([^`\n]+)`/g)]
    .map((span) => span[1].trim()).filter((span) => span !== '--force-conflicts')
  // The bare inline flag in policy prose and the verify-ok-shared-live.sh warning are mentions.
  for (const command of [...blocks.map((block) => block[3]), ...inlineCommands]) {
    expect(command, 'documented commands must omit --force-conflicts').not.toMatch(/--force-conflicts\b/)
  }
}

it.each([
  ['rejects a removed kuberc export', checkKuberc, 'export KUBECTL_KUBERC=false\n', '', /before the first gate or k invocation/],
  ['rejects an unknown flag', checkGateCommands, '--allowlist "$PRE_H_ALLOWLIST"', '--allow-list "$PRE_H_ALLOWLIST"', /unknown or duplicate flag/],
  ['rejects an unknown mode', checkGateCommands, 'gate ownership-inventory', 'gate inventory', /unknown mode/],
  ['rejects a missing required flag', checkGateCommands, ' --allowlist "$PRE_H_ALLOWLIST"', '', /missing --allowlist/],
  ['rejects a file of the wrong shape', checkGateCommands, '--allowlist "$PRE_H_ALLOWLIST"', '--allowlist "$PRE_H_SNAPSHOT"', /invalid allowlist object/],
  ['rejects a wrapper without a namespace', checkGateTarget, ' --namespace openkubes-console', '', /gate\(\) must pass --namespace openkubes-console/],
  ['rejects a forced inline command', checkNonForced, 'k apply --server-side', 'k apply --force-conflicts --server-side', /documented commands must omit --force-conflicts/],
  ['rejects a forced fenced command', checkNonForced, 'k apply --server-side --dry-run=server', 'k apply --force-conflicts=true --server-side --dry-run=server', /documented commands must omit --force-conflicts/],
  ['rejects an untagged gate fence', checkGateCommands, '```bash\ngate ownership-inventory --allowlist "$PRE_H_ALLOWLIST"', '```\ngate ownership-inventory --allowlist "$PRE_H_ALLOWLIST"', /expected 7 documented gate invocations, found 6:[\s\S]*gate ownership-release/],
  [
    'stops before node or kubectl when the approved digest differs',
    (markdown: string) => checkGateTarget(markdown, 'STOP: ok170-gates.mjs SHA-256 differs from the approved G0 package'),
    'export KUBECTL_KUBERC=false\n',
    `export KUBECTL_KUBERC=false\nexport GATE_SHA256=${'0'.repeat(64)}\n`,
  ],
] as const)('%s', (_name, check, original, replacement, reason) => {
  expect(procedure).toContain(original)
  const modified = procedure.replace(original, replacement)
  if (reason) {
    expect(() => check(modified)).toThrow(reason)
  } else {
    check(modified)
  }
})

it('exports KUBECTL_KUBERC=false before the first gate or k invocation', () => checkKuberc(procedure))
it('passes every documented gate mode, flag and input through the real CLI', () => checkGateCommands(procedure))
it('passes the ok-shared context and Console namespace through gate()', () => checkGateTarget(procedure))
it('omits --force-conflicts from documented commands', () => checkNonForced(procedure))
