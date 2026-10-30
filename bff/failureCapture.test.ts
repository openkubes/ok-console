// @vitest-environment node
import { stripVTControlCharacters } from 'node:util'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const parseLines = (output: string) => stripVTControlCharacters(output).split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))

it('parses ANSI reset codes before a JSON failure line', () => {
  expect(JSON.parse.bind(null, '\x1b[0m{"nodeCode":"EPIPE"}\x1b[0m')).toThrow()
  expect(parseLines('\x1b[0m{"nodeCode":"EPIPE"}\x1b[0m\n')).toEqual([{ nodeCode: 'EPIPE' }])
})

it('prints captured bounded failure lines and the test clock step only when a test fails', async () => {
  const root = mkdtempSync('bff/test-fixtures/capture-check-')
  try {
    const path = join(root, 'capture.test.ts')
    writeFileSync(path, `// @vitest-environment node
import { captureFailure, captureChildFailureLines } from '../failureCapture'
import { expect, it, vi } from 'vitest'
import { OpenKubesObservedStateAdapter } from '../../adapters/openKubesObservedState.mjs'
import { classifySourceFailure, sourceFailureLogLine } from '../../adapters/sourceFailure.mjs'
it('intentional diagnostic failure', async () => {
 const dateMock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 60000)
 const adapter = new OpenKubesObservedStateAdapter({ url: 'https://localhost/', fetchImpl: async () => { throw Object.assign(new Error('private'), {code:'ECONNREFUSED'}) } })
 await adapter.readSnapshot().catch(() => {})
 captureFailure(Object.assign(new Error('private direct'), {code:'EPIPE'}))
 const childError = Object.assign(new Error('private child'), {code:'ECONNRESET'})
 captureChildFailureLines('unstructured child output\\n' + sourceFailureLogLine('/', classifySourceFailure(childError), undefined, childError))
 if (process.env.CAPTURE_RESTORE_CLOCK === '1') dateMock.mockRestore()
 if (process.env.CAPTURE_FORCE_COLOR !== '1') expect(process.env.NO_COLOR).toBe('1')
 expect(1).toBe(Number(process.env.CAPTURE_EXPECT))
})
`, { flag: 'wx' })
    const config = join(root, 'vitest.config.mjs')
    writeFileSync(config, 'export default ' + JSON.stringify({ test: { include: [path], environment: 'node', maxWorkers: 1, fileParallelism: false } }), { flag: 'wx' })
    const run = (expected: string, restoreClock = false, forceColor = false) => new Promise<{ status: number | null, stdout: string, stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, path], { env: { ...process.env, ...(forceColor ? { FORCE_COLOR: '1', CAPTURE_FORCE_COLOR: '1' } : {}), CAPTURE_EXPECT: expected, CAPTURE_RESTORE_CLOCK: restoreClock ? '1' : '0', NO_COLOR: forceColor ? undefined : '1' } })
      let stdout = '', stderr = ''
      child.stdout.on('data', (data) => { stdout += data })
      child.stderr.on('data', (data) => { stderr += data })
      child.on('error', reject)
      child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
    const failed = await run('0', false, true)
    expect(failed.status).toBe(1)
    const output = failed.stdout + failed.stderr
    const lines = parseLines(output)
    const clock = lines.find((line) => line.testClock === 'WALL_VS_MONOTONIC')
    expect(clock).toMatchObject({ wallClockStepMs: expect.any(Number) })
    expect(clock.wallClockStepMs).toBeLessThan(-59000)
    expect(lines.find((line) => line.nodeCode === 'ECONNREFUSED')).toMatchObject({ failedStage: 'OTHER', stages: [], elapsedMs: expect.any(Number) })
    expect(lines.some((line) => line.nodeCode === 'EPIPE')).toBe(true)
    expect(lines.some((line) => line.nodeCode === 'ECONNRESET')).toBe(true)
    expect(output).not.toContain('"message":"private"')
    const colored = failed
    expect(colored.status).toBe(1)
    const coloredOutput = colored.stdout + colored.stderr
    expect(coloredOutput).toContain(String.fromCharCode(27) + '[')
    expect(parseLines(coloredOutput).some((line) => line.nodeCode === 'EPIPE')).toBe(true)
    // Control: the same FORCE_COLOR output cannot be parsed without stripping.
    let unstripped: unknown
    try { unstripped = coloredOutput.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)) } catch { unstripped = 'parse failed' }
    expect(unstripped).not.toEqual(parseLines(coloredOutput))
    console.info('D4_R7_ANSI ' + JSON.stringify({ FORCE_COLOR: '1', ansiPresent: true, strippedParseSucceeded: true, unstrippedParseFailedOrLostLines: true }))
    const passed = await run('1')
    expect(passed.status).toBe(0)
    expect(passed.stdout + passed.stderr).not.toContain('WALL_VS_MONOTONIC')
    expect(passed.stdout + passed.stderr).not.toContain('"nodeCode":"ECONNREFUSED"')
    const cancelled = await run('0', true)
    expect(cancelled.status).toBe(1)
    const net = parseLines(cancelled.stdout + cancelled.stderr).find((line) => line.testClock === 'WALL_VS_MONOTONIC')
    expect(net).toBeDefined()
    expect(Math.abs(net.wallClockStepMs)).toBeLessThanOrEqual(2)
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 120000)

it('routes every repository certificate generator through the shared validity-margin fixture helper', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : /\.(?:ts|mjs)$/.test(entry.name) ? [join(dir, entry.name)] : [])
  const generators = walk('bff').filter((path) => !path.endsWith('failureCapture.test.ts')).filter((path) => /openssl\(['"](?:req|genrsa)|execFileSync\(opensslBinary/.test(readFileSync(path, 'utf8')))
  expect(generators.sort()).toEqual(['bff/d4TrustDiagnostics.test.ts', 'bff/observedStateMtls.test.ts', 'bff/security/d4R9.test.ts', 'bff/test-fixtures/certificates.mjs', 'bff/test-fixtures/d4R11OidcModes.mjs', 'bff/test-fixtures/oidcTokenEndpoint.mjs'])
  for (const path of generators.filter((path) => path.endsWith('.test.ts'))) {
    const source = readFileSync(path, 'utf8')
    expect(source).toContain('issueTestCertificate(')
    expect(source).not.toMatch(/['"]-days['"]|['"]-x509['"]|openssl\(['"]x509/)
    expect(source).toContain('validFrom')
    expect(source).toContain('validTo')
  }
})
