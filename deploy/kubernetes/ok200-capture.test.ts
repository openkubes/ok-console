// @vitest-environment node

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const helper = fileURLToPath(new URL('./capture-local-kind-failure.sh', import.meta.url))
const realFixtures = fileURLToPath(new URL('./fixtures/ok200/', import.meta.url))
let fixtureDirectory = ''
let execution = 0

const kubectlStub = `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'kubectl %s\\n' "$*" >>"$CAPTURE_ARGV_LOG"
case "$*" in
  'version --client')
    if [[ -n "\${CAPTURE_VERSION_FIXTURE:-}" ]]; then
      cat "$CAPTURE_VERSION_FIXTURE"
    else
      printf 'Client Version: v1.32.0\\n'
    fi
    printf 'Authorization: Bearer planted-bearer-7f3c\\n'
    printf 'clusters:\\n- cluster:\\n  certificate-authority-data: kubeconfig-like-planted-value\\n'
    printf 'https://secret.example.invalid/?token=planted-url-token\\n' >&2
    ;;
  *' get pods '*|*' get pods -o '*)
    printf 'current-pod|pod-uid|rs-uid|Running|True||2026-10-19T09:00:00Z\\n'
    printf 'sensitive-pod|pod-uid|rs-uid|Running|True||token=planted-pod-token\\n'
    printf 'https://planted-pod-url.invalid\\n' >&2
    ;;
  *' get replicasets '*|*' get replicasets -o '*)
    printf 'current-rs|rs-uid|deployment-uid|7|1|1|1|1|2026-10-19T08:59:00Z\\n'
    printf 'authorization: Bearer planted-rs-bearer\\n' >&2
    ;;
  *) printf 'unexpected kubectl invocation: %s\\n' "$*" >&2; exit 2 ;;
esac
`

const kindStub = `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'kind %s\\n' "$*" >>"$CAPTURE_ARGV_LOG"
[[ "$*" == version ]] || { printf 'unexpected kind invocation: %s\\n' "$*" >&2; exit 2; }
if [[ "\${CAPTURE_SCENARIO:-}" == slow ]]; then
  printf 'started\\n' >"$CAPTURE_SLOW_MARKER"
  trap '' TERM
  exec /bin/sleep 8
fi
printf 'kind v0.25.0 go1.23.0 linux/amd64\\n'
printf 'kubeconfig: planted-kubeconfig-secret\\n'
`

const dockerStub = `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'docker %s\\n' "$*" >>"$CAPTURE_ARGV_LOG"
[[ "$*" == 'exec test-control-plane containerd --version' ]] || { printf 'unexpected docker invocation: %s\\n' "$*" >&2; exit 2; }
printf 'containerd github.com/containerd/containerd v2.0.0\\n'
printf 'secret planted-docker-secret\\n' >&2
`

const ssStub = `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'ss %s\\n' "$*" >>"$CAPTURE_ARGV_LOG"
[[ "$*" == '-ltn sport = :18787' ]] || exit 2
printf 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\\n'
printf 'LISTEN 0 4096 127.0.0.1:18787 0.0.0.0:*   \\n'
printf 'LISTEN 0 128 127.0.0.1:9999 0.0.0.0:* bearer planted-listener-secret\\n'
`

const lsofStub = `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'lsof %s\\n' "$*" >>"$CAPTURE_ARGV_LOG"
[[ "$*" == '-nP -iTCP:18787 -sTCP:LISTEN' ]] || exit 2
printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n'
printf 'kubectl 1234 user 7u IPv4 0t0 TCP 127.0.0.1:18787 (LISTEN)\\n'
printf 'kubectl 1234 user 8u IPv4 0t0 TCP 127.0.0.1:9999 (LISTEN)\\n'
`

const findExecutable = (name: string) => {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue searching PATH when this entry is missing or not executable.
    }
  }
  return undefined
}

const timeoutStub = `#!${process.execPath}
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
const duration = args.find((value) => /^\\d+s$/.test(value))
if (!duration) process.exit(125)
const nativeTimeout = ${JSON.stringify(findExecutable('timeout') ?? '')}
if (nativeTimeout) {
  const native = spawn(nativeTimeout, args, { stdio: 'inherit' })
  native.on('error', () => process.exit(127))
  native.on('close', (code, signal) => process.exit(code ?? (signal ? 128 : 0)))
} else {
const command = args.slice(args.indexOf(duration) + 1)
if (!command.length) process.exit(125)
const child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
let timedOut = false
let killTimer
const timeout = setTimeout(() => {
  timedOut = true
  child.kill('SIGTERM')
  killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
}, Number(duration.slice(0, -1)) * 1000)
child.on('error', () => process.exit(127))
child.on('close', (code, signal) => {
  clearTimeout(timeout)
  clearTimeout(killTimer)
  process.exit(timedOut ? 124 : (code ?? (signal ? 128 : 0)))
})
}
`

const executable = (name: string) => {
  const candidate = findExecutable(name)
  if (!candidate) throw new Error(`Required host executable is unavailable: ${name}`)
  return candidate
}

const makeCapturePath = async (name: string, options: { ss?: boolean; lsof?: boolean } = {}) => {
  const directory = join(fixtureDirectory, name)
  await mkdir(directory)
  const hostTools = ['bash', 'awk', 'cat', 'date', 'head', 'rm', 'wc', 'sleep']
  const stubs = ['kubectl', 'kind', 'docker', 'timeout']
  for (const tool of hostTools) await symlink(executable(tool), join(directory, tool))
  for (const tool of stubs) await symlink(tool === 'timeout' ? join(fixtureDirectory, 'timeout') : join(fixtureDirectory, tool), join(directory, tool))
  if (options.ss) await symlink(join(fixtureDirectory, 'ss'), join(directory, 'ss'))
  if (options.lsof) await symlink(join(fixtureDirectory, 'lsof'), join(directory, 'lsof'))
  return directory
}

beforeAll(async () => {
  const bash = await exec('bash', ['-c', 'printf "%s.%s\\n" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'])
  const [bashMajor, bashMinor] = bash.stdout.trim().split('.').map(Number)
  expect(bashMajor > 4 || (bashMajor === 4 && bashMinor >= 4), `Tests require Bash 4.4 or newer; found ${bash.stdout.trim()}. On macOS install Homebrew Bash and put it first on PATH.`).toBe(true)
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'ok-console-ok200-capture-'))
  for (const [name, contents] of Object.entries({ kubectl: kubectlStub, kind: kindStub, docker: dockerStub, ss: ssStub, lsof: lsofStub, timeout: timeoutStub })) {
    await writeFile(join(fixtureDirectory, name), contents)
    await chmod(join(fixtureDirectory, name), 0o755)
  }
  await makeCapturePath('ss-tools-bin', { ss: true })
  await makeCapturePath('lsof-tools-bin', { lsof: true })
  await makeCapturePath('no-listener-tools-bin')
})

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true })
})

const environment = (scenario = 'normal', path = `${fixtureDirectory}:${process.env.PATH}`) => {
  const id = execution++
  return {
    ...process.env,
    PATH: path,
    CAPTURE_ARGV_LOG: join(fixtureDirectory, `argv-${id}.log`),
    CAPTURE_SCENARIO: scenario,
    CAPTURE_SLOW_MARKER: join(fixtureDirectory, `slow-marker-${id}`),
  }
}

const capture = async (scenario = 'normal', suppliedNetstatBaseline?: string, versionFixture?: string, path = `${fixtureDirectory}:${process.env.PATH}`, overrides: Record<string, string> = {}) => {
  const env = { ...environment(scenario, path), CAPTURE_VERSION_FIXTURE: versionFixture ?? '', ...overrides }
  const directory = join(fixtureDirectory, `artifacts-${execution}`)
  await mkdir(directory)
  const netstatBaseline =
    suppliedNetstatBaseline ?? (await exec('bash', [helper, 'snapshot-netstat'], { env })).stdout.trim()
  const forwardLog = join(fixtureDirectory, `forward-${execution}.log`)
  await writeFile(forwardLog, [
    'Forwarding from 127.0.0.1:18787 -> 8787',
    'klog I1019 09:42:11.213456 round_trippers.go:553 GET status=503 elapsed=12 milliseconds',
    'Authorization: Bearer planted-forward-bearer',
    'apiVersion: v1',
    'clusters:',
    'client-key-data: planted-forward-kubeconfig-key',
    '',
  ].join('\n'))
  const started = performance.now()
  const result = await exec(
    'bash',
    [helper, 'capture', directory, 'test', '18787', 'current-pod', '9', forwardLog, netstatBaseline],
    {
      env,
      timeout: 10000,
      killSignal: 'SIGKILL',
    },
  )
  return { directory, env, elapsedMs: performance.now() - started, netstatBaseline, result }
}

const procCountersAvailable = () => {
  if (process.platform === 'darwin') return false
  if (process.platform !== 'linux') throw new Error(`Unsupported test platform for OK-200 capture: ${process.platform}`)
  const source = process.env.OK200_PROC_NET_NETSTAT || '/proc/net/netstat'
  try {
    accessSync(source, constants.R_OK)
    return true
  } catch {
    return false
  }
}

describe('OK-200 failure diagnostic capture', () => {
  it.each(['1.27.4', '1.37.1'])('filters reconstructed real kubectl %s occupied-port output', async (version) => {
    const output = join(fixtureDirectory, `occupied-${version}-${execution++}.log`)
    await exec('bash', ['-c', 'cat "$1" | bash "$2" filter-port-forward "$3"', '_',
      join(realFixtures, `kubectl-${version}-occupied-port.reconstructed.log`), helper, output], { env: environment() })
    const sanitized = await readFile(output, 'utf8')
    expect(sanitized).toBe(await readFile(join(realFixtures, `kubectl-${version}-occupied-port.expected.txt`), 'utf8'))
    expect(sanitized).not.toMatch(/example\.invalid|current-pod|https?:|token|authorization/i)
    const refiltered = join(fixtureDirectory, `occupied-refiltered-${version}-${execution++}.log`)
    await exec('bash', ['-c', 'cat "$1" | bash "$2" filter-port-forward "$3"', '_', output, helper, refiltered], { env: environment() })
    expect(await readFile(refiltered, 'utf8')).toBe(sanitized)
  })

  it.each(['1.27.4', '1.37.1'])('filters real kubectl %s unreachable-server klog output', async (version) => {
    const output = join(fixtureDirectory, `real-${version}-${execution++}.log`)
    await exec('bash', ['-c', 'cat "$1" | bash "$2" filter-port-forward "$3"', '_',
      join(realFixtures, `kubectl-${version}-refused.log`), helper, output], { env: environment() })
    const sanitized = await readFile(output, 'utf8')
    expect(sanitized).toBe(await readFile(join(realFixtures, `kubectl-${version}-refused.expected.txt`), 'utf8'))
    expect(sanitized).not.toMatch(/127\.0\.0\.1|https?:|timeout=|token|authorization/i)
  })

  it.each(['1.27.4', '1.37.1'])('keeps the real kubectl %s client version and separate terminated lines', async (version) => {
    const { directory } = await capture('normal', undefined, join(realFixtures, `kubectl-${version}-version.txt`))
    const kustomize = version === '1.27.4' ? 'v5.0.1' : 'v5.8.1'
    expect(await readFile(join(directory, 'versions.txt'), 'utf8')).toBe(
      `Client Version: v${version}\nKustomize Version: ${kustomize}\nkind v0.25.0 go1.23.0 linux/amd64\ncontainerd github.com/containerd/containerd v2.0.0\n`,
    )
    expect(await readFile(join(directory, 'listener.txt'), 'utf8')).toBe('LISTEN 0 4096 127.0.0.1:18787 0.0.0.0:*   \n')
  })

  it.each(['abc', '0', '-1'])('rejects remaining_seconds=%s before starting any capture command', async (remaining) => {
    const marker = join(fixtureDirectory, `guard-command-${execution++}`)
    await expect(exec('bash', ['-c', `source "$1"
deadline=$((SECONDS + 100))
remaining_value="$2"
remaining_seconds() { printf '%s\\n' "$remaining_value"; }
run_capture_command touch "$3"
`, '_', helper, remaining, marker], { env: environment() })).rejects.toMatchObject({ code: 124 })
    expect(await readdir(fixtureDirectory)).not.toContain(marker.split('/').at(-1))
  })

  it.each([
    ['/api/v1/pods', 'core-api'],
    ['/api/v1/namespaces/private/pods/private/portforward', 'pod-portforward'],
    ['/apis/apps/v1', 'grouped-api'],
    ['/version', 'version'],
    ['/private', 'other'],
    ['', 'other'],
  ])('classifies legacy status-bearing path %s without retaining its URL', async (path, pathClass) => {
    const output = join(fixtureDirectory, `legacy-path-${execution++}.log`)
    const input = `I1019 09:42:11.213456       1 round_trippers.go:553] POST https://api.internal.invalid${path}?token=planted-legacy-token 101 Switching Protocols in 12 milliseconds`
    await exec('bash', ['-c', 'printf "%s" "$1" | bash "$2" filter-port-forward "$3"', '_', input, helper, output], { env: environment() })
    expect(await readFile(output, 'utf8')).toBe(
      `klog I1019 09:42:11.213456 round_trippers.go:553 POST path=${pathClass} status=101 elapsed=12 milliseconds\n`,
    )
  })

  it.each(['v1.27.4; arbitrary payload', 'v1.27.4\u001b[31mcontrol'])('drops an unsafe legacy GitVersion: %s', async (version) => {
    const line = `Client Version: version.Info{Major:"1", Minor:"27", GitVersion:"${version}", Platform:"linux/amd64"}`
    const { stdout } = await exec('bash', ['-c', 'source "$1"; sanitize_command_output versions "$2"', '_', helper, line], { env: environment() })
    expect(stdout).toBe('')
  })

  it.each([
    ['versions', 'Client Version: v1.27.4\nKustomize Version: v5.0.1\n'],
    ['listener', 'LISTEN 0 4096 127.0.0.1:18787 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:18788 0.0.0.0:*\n'],
  ])('keeps only complete %s lines at file and aggregate byte caps', async (kind, content) => {
    const directory = join(fixtureDirectory, `cap-lines-${execution++}`)
    const saved = `${directory}-saved.txt`
    await mkdir(directory)
    const firstLine = content.slice(0, content.indexOf('\n') + 1)
    const limit = Buffer.byteLength(firstLine) + 5
    const script = `source "$1"
artifact_dir="$2"
content="$(sanitize_command_output "$3" "$4"; printf '\\001')"
content="\${content%$'\\001'}"
append_file "$2/file.txt" "$content" "$5"
mv "$2/file.txt" "$6"
head -c "$((total_cap - $5))" /dev/zero > "$2/padding.txt"
append_file "$2/aggregate.txt" "$content" 32768
`
    await exec('bash', ['-c', script, '_', helper, directory, kind, content, String(limit), saved], { env: environment() })
    expect(await readFile(saved, 'utf8')).toBe(firstLine)
    expect(await readFile(join(directory, 'aggregate.txt'), 'utf8')).toBe(firstLine)
  })

  it('filters port-forward output to useful bounded lines and drops bearer, URL, and kubeconfig material', async () => {
    const output = join(fixtureDirectory, 'filtered-forward.log')
    const input = [
      'Forwarding from 127.0.0.1:18787 -> 8787',
      'Handling connection for 18787',
      'error: unable to forward connection: connection refused',
      'I1019 09:42:11.213456       1 round_trippers.go:553] GET https://api.internal.invalid/api/v1/pods?token=planted-trace-token 503 Service Unavailable in 12 milliseconds',
      'I1019 09:42:11.313456       1 round_trippers.go:553] GET https://api.internal.invalid/api/v1/pods?token=planted-empty-status-token  in 13 milliseconds',
      'I1019 09:42:11.213456       1 portforward.go:406] GET https://api.internal.invalid/api/v1/pods?token=planted-portforward-trace-token (503) 12ms',
      'I1019 09:42:11.213456       1 round_trippers.go:632] "Response" verb="POST" url="https://api.internal.invalid/api/v1/namespaces/openkubes-console/pods/current-pod/portforward?token=planted-structured-token" status="101 Switching Protocols" milliseconds=17',
      'I1019 09:42:12.113456       1 round_trippers.go:632] "Response" verb="GET" url="https://api.internal.invalid/api?token=planted-refused-response-token" status="" milliseconds=150',
      'E1019 09:42:12.213456       1 memcache.go:265] couldn\'t get current server API group list: Get "https://api.internal.invalid/api?token=planted-memcache-token": dial tcp 127.0.0.1:6443: connect: connection refused',
      'E1019 09:42:13.213456       1 portforward.go:406] error copying from remote stream to local connection: read tcp 127.0.0.1:18787: connection reset by peer',
      'E1019 09:42:14.213456       1 round_trippers.go:632] request failed: dial tcp 127.0.0.1:6443: i/o timeout',
      'E1019 09:42:15.213456       1 spdy.go:97] stream terminated with EOF',
      'E1019 09:42:16.213456       1 tunneling_dialer.go:102] unable to upgrade streaming request: websocket: bad handshake',
      'E1019 09:42:17.213456       1 fallback_dialer.go:53] fallback to secondary dialer from primary dialer err: unable to upgrade streaming request',
      'F1019 09:42:18.213456       1 helpers.go:115] Unable to connect to the server: Get "https://api.internal.invalid/api?token=planted-tls-token": tls: failed to verify certificate',
      'E1019 09:42:19.213456       1 memcache.go:265] connection refused after TLS upgrade ended with EOF',
      'E1019 09:42:20.213456       1 portforward.go:406] connection reset by peer after TLS upgrade ended with EOF',
      'E1019 09:42:21.213456       1 round_trippers.go:632] i/o timeout after TLS upgrade ended with EOF',
      'E1019 09:42:22.213456       1 spdy.go:97] mtls failure thereof',
      'Authorization: Bearer planted-filter-bearer',
      'https://internal.example.invalid/path?token=planted-filter-url',
      'apiVersion: v1',
      'apiversion: v1',
      'clusters:',
      'certificate-authority-data: planted-kubeconfig-ca-data',
      'client-key-data: planted-kubeconfig-client-key',
      'token: planted-kubeconfig-token',
      `Forwarding from 127.0.0.1:18787 -> 8787${' '.repeat(20000)}`,
    ].join('\n')
    const inputFile = join(fixtureDirectory, 'raw-forward.log')
    await writeFile(inputFile, input)
    const result = await exec('bash', ['-c', 'cat "$1" | bash "$2" filter-port-forward "$3"', '_', inputFile, helper, output], {
      env: environment(),
    })
    const sanitized = await readFile(output, 'utf8')
    expect(sanitized).not.toMatch(/planted-|Authorization|https:|apiVersion|clusters:/i)
    expect(result.stderr).toBe('')
    expect(sanitized).toContain('Forwarding from 127.0.0.1:18787 -> 8787')
    expect(sanitized).toContain('Handling connection for 18787')
    expect(sanitized).toContain('error: kubectl was unable to forward the requested port (details omitted)')
    expect(sanitized).toContain('round_trippers.go:553 GET path=core-api status=503 elapsed=12 milliseconds')
    expect(sanitized).toContain('round_trippers.go:553 GET path=core-api status=none milliseconds=13')
    expect(sanitized).toContain('portforward.go:406 GET status=503 elapsed=12ms')
    expect(sanitized).toContain(
      'round_trippers.go:632 POST path=pod-portforward status=101 milliseconds=17',
    )
    expect(sanitized).toContain(
      'round_trippers.go:632 GET path=core-api status=unavailable milliseconds=150',
    )
    expect(sanitized).toContain('memcache.go:265 diagnostic=connection-refused')
    expect(sanitized).toContain('portforward.go:406 diagnostic=connection-reset')
    expect(sanitized).toContain('round_trippers.go:632 diagnostic=i/o-timeout')
    expect(sanitized).toContain('spdy.go:97 diagnostic=eof')
    expect(sanitized).toContain('tunneling_dialer.go:102 diagnostic=upgrade-failed')
    expect(sanitized).toContain('fallback_dialer.go:53 diagnostic=fallback-to-spdy')
    expect(sanitized).toContain('helpers.go:115 diagnostic=tls')
    expect(sanitized).toContain('spdy.go:97 diagnostic=other')
    expect(Buffer.byteLength(sanitized)).toBeLessThanOrEqual(16384)
    const refilteredOutput = join(fixtureDirectory, 'refiltered-forward.log')
    await exec('bash', ['-c', 'cat "$1" | bash "$2" filter-port-forward "$3"', '_', output, helper, refilteredOutput], {
      env: environment(),
    })
    expect(await readFile(refilteredOutput, 'utf8')).toBe(sanitized)
  })

  it.each([
    'GET https://raw-host.invalid?next=/api/v1&token=planted-query-token  in 13 milliseconds',
    '"Response" verb="GET" url="https://raw-host.invalid?next=/api/v1&token=planted-query-token" status="" milliseconds=13',
  ])('does not classify a query-only URL as an API path: %s', async (detail) => {
    const output = join(fixtureDirectory, `query-only-${execution++}.log`)
    const input = `I1019 09:42:11.313456       1 round_trippers.go:553] ${detail}`
    await exec('bash', ['-c', 'printf "%s\\n" "$1" | bash "$2" filter-port-forward "$3"', '_', input, helper, output], {
      env: environment(),
    })
    const sanitized = await readFile(output, 'utf8')
    expect(sanitized).toContain('GET path=other status=')
    expect(sanitized).toContain('milliseconds=13')
    expect(sanitized).not.toMatch(/raw-host|planted-|next=|https:/)
  })

  it.each([
    {
      name: 'forwarding error with Get URL EOF',
      input: 'error: an error occurred forwarding 18787 -> 8787: Get "https://raw-host.invalid/api?token=planted-eof-token": EOF',
      expected: 'error: kubectl reported a forwarding error (details omitted)\n',
    },
    {
      name: 'unable-to-forward error with a token',
      input: 'error: unable to forward port 8787 to pod: token=planted-forward-token',
      expected: 'error: kubectl was unable to forward the requested port (details omitted)\n',
    },
    {
      name: 'nested connection-upgrade error with secret URL material',
      input: 'error: error upgrading connection: Get "https://raw-host.invalid/api?token=planted-upgrade-token": secret=planted-secret',
      expected: 'error: kubectl port-forward upgrade failed (details omitted)\n',
    },
  ])('maps $name before sensitive-marker filtering', async ({ input, expected }) => {
    const output = join(fixtureDirectory, `fixed-error-${execution++}.log`)
    await exec('bash', ['-c', 'printf "%s\\n" "$1" | bash "$2" filter-port-forward "$3"', '_', input, helper, output], {
      env: environment(),
    })
    const sanitized = await readFile(output, 'utf8')
    expect(sanitized).toBe(expected)
    expect(sanitized).not.toMatch(/raw-host|planted-|token=|secret=/i)
  })

  it.each([
    ['tls-x509', 'x509: certificate signed by unknown authority'],
    ['tls-x509', 'tls: failed to verify certificate: x509: certificate has expired'],
    ['connection-refused', 'connection refused after TLS upgrade ended with EOF'],
    ['connection-reset', 'connection reset by peer after TLS upgrade ended with EOF'],
    ['i/o-timeout', 'i/o timeout after TLS upgrade ended with EOF'],
    ['other', 'mtls failure thereof'],
  ])('uses explicit klog precedence for %s', async (diagnosticClass, detail) => {
    const output = join(fixtureDirectory, `precedence-${execution++}.log`)
    const input = `E1019 09:43:02.213456       1 round_trippers.go:632] ${detail}`
    await exec('bash', ['-c', 'printf "%s\\n" "$1" | bash "$2" filter-port-forward "$3"', '_', input, helper, output], {
      env: environment(),
    })
    expect(await readFile(output, 'utf8')).toBe(
      `klog E1019 09:43:02.213456 round_trippers.go:632 diagnostic=${diagnosticClass}\n`,
    )
  })

  it('keeps malformed forwarding readiness markers safe so the verifier can reject them', async () => {
    const output = join(fixtureDirectory, 'malformed-forward.log')
    const input = [
      'Forwarding from 127.0.0.1:18787 -> 9999',
      'Forwarding from 127.0.0.1:18787 -> 8787 trailing token=planted-forward-token',
      'Forwarding from 127.0.0.1:18788 -> 8787',
    ].join('\n')
    await exec('bash', ['-c', 'printf "%s\\n" "$1" | bash "$2" filter-port-forward "$3"', '_', input, helper, output], {
      env: environment(),
    })
    const sanitized = await readFile(output, 'utf8')
    expect(sanitized).toContain('Forwarding from 127.0.0.1:18787 -> unexpected endpoint')
    expect(sanitized).toContain('Forwarding from 127.0.0.1:18788 -> 8787')
    expect(sanitized).not.toContain('9999')
    expect(sanitized).not.toContain('planted-')
  })

  it('returns only the local TCP listen-overflow counter pair', async () => {
    const { stdout, stderr } = await exec('bash', [helper, 'snapshot-netstat'], { env: environment() })
    expect(stderr).toBe('')
    if (procCountersAvailable()) {
      expect(stdout).toMatch(/^TcpExt ListenOverflows=\d+ ListenDrops=\d+\n$/)
    } else {
      expect(stdout).toBe('TcpExt ListenOverflows=unavailable ListenDrops=unavailable\n')
    }
  })

  it('reports proc counters unavailable when the proc net source cannot be read', async () => {
    const procUnavailable = join(fixtureDirectory, 'missing-proc-netstat')
    const { stdout, stderr } = await exec('bash', [helper, 'snapshot-netstat'], {
      env: { ...environment(), OK200_PROC_NET_NETSTAT: procUnavailable },
    })
    expect(stderr).toBe('')
    expect(stdout).toBe('TcpExt ListenOverflows=unavailable ListenDrops=unavailable\n')
    const baseline = 'TcpExt ListenOverflows=unavailable ListenDrops=unavailable'
    const { directory } = await capture('normal', baseline, undefined, `${fixtureDirectory}:${process.env.PATH}`, {
      OK200_PROC_NET_NETSTAT: procUnavailable,
    })
    const netstat = await readFile(join(directory, 'netstat.txt'), 'utf8')
    expect(netstat).toContain(`start ${baseline}`)
    expect(netstat).toContain(`end ${baseline}`)
    expect(netstat).toContain(`delta ${baseline}`)
  })

  it('preserves valid start and end counters when a decreasing counter makes the delta unavailable', async () => {
    const baseline = 'TcpExt ListenOverflows=999999999999 ListenDrops=999999999999'
    const { directory } = await capture('normal', baseline)
    const netstat = await readFile(join(directory, 'netstat.txt'), 'utf8')
    expect(netstat).toContain(`start ${baseline}`)
    if (procCountersAvailable()) {
      expect(netstat).toMatch(/^end TcpExt ListenOverflows=\d+ ListenDrops=\d+$/m)
    } else {
      expect(netstat).toContain('end TcpExt ListenOverflows=unavailable ListenDrops=unavailable')
    }
    expect(netstat).toContain('delta TcpExt ListenOverflows=unavailable ListenDrops=unavailable')
  })

  it('keeps a missing verification-start counter unavailable instead of fabricating a failure-time baseline', async () => {
    const unavailable = 'TcpExt ListenOverflows=unavailable ListenDrops=unavailable'
    const { directory } = await capture('normal', unavailable)
    const netstat = await readFile(join(directory, 'netstat.txt'), 'utf8')
    expect(netstat).toContain(`start ${unavailable}`)
    if (procCountersAvailable()) {
      expect(netstat).toMatch(/^end TcpExt ListenOverflows=\d+ ListenDrops=\d+$/m)
    } else {
      expect(netstat).toContain('end TcpExt ListenOverflows=unavailable ListenDrops=unavailable')
    }
    expect(netstat).toContain(`delta ${unavailable}`)
  })

  it('clamps version, Pod, and ReplicaSet command timeouts to the remaining capture budget', async () => {
    const timeoutDirectory = join(fixtureDirectory, `timeout-${execution++}`)
    const artifacts = join(fixtureDirectory, `deadline-artifacts-${execution++}`)
    const timeoutLog = join(fixtureDirectory, `deadline-timeout-${execution++}.log`)
    await mkdir(timeoutDirectory)
    await mkdir(artifacts)
    await writeFile(
      join(timeoutDirectory, 'timeout'),
      `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' "$*" >>"$CAPTURE_TIMEOUT_LOG"
`,
    )
    await chmod(join(timeoutDirectory, 'timeout'), 0o755)
    const env = {
      ...environment(),
      PATH: `${timeoutDirectory}:${fixtureDirectory}:${process.env.PATH}`,
      CAPTURE_TIMEOUT_LOG: timeoutLog,
    }
    await exec(
      'bash',
      [
        '-c',
        `source "$1"
artifact_dir="$2"
: >"$2/version.txt"
deadline=$((SECONDS + 100))
remaining_seconds() { printf '1\\n'; }
run_bounded versions "$2/version.txt" 1024 kubectl version --client
capture_workloads "$2/workloads.txt" kind-test
`,
        '_',
        helper,
        artifacts,
      ],
      { env },
    )
    const calls = await readFile(timeoutLog, 'utf8')
    expect(calls).toContain('--signal=TERM --kill-after=1s 1s kubectl version --client')
    expect(calls).toMatch(/--signal=TERM --kill-after=1s 1s kubectl .* get pods /)
    expect(calls).toMatch(/--signal=TERM --kill-after=1s 1s kubectl .* get replicasets /)
    expect(calls.trim().split('\n').every((call) => call.includes('--kill-after=1s 1s '))).toBe(true)
  })

  it('caps a flood of valid forwarding lines by bytes', async () => {
    const output = join(fixtureDirectory, 'flood-forward.log')
    const lines = [
      'Forwarding from 127.0.0.1:18787 -> 8787',
      'Handling connection for 18787',
      'error: unable to forward connection: request refused',
      'I1019 09:42:11.213456       1 round_trippers.go:553] GET https://api.internal.invalid/api/v1/pods?token=planted-flood-token 503 Service Unavailable in 12 milliseconds',
      'Authorization: Bearer planted-flood-bearer',
      'error: arbitrary command output contained token=planted-flood-arbitrary-token',
    ]
    const input = Array.from({ length: 1200 }, (_, index) => lines[index % lines.length]).join('\n')
    const inputFile = join(fixtureDirectory, 'flood-forward.raw')
    await writeFile(inputFile, input)
    await exec('bash', ['-c', 'cat "$1" | bash "$2" filter-port-forward "$3"', '_', inputFile, helper, output], {
      env: environment(),
    })
    const sanitized = await readFile(output, 'utf8')
    expect(Buffer.byteLength(sanitized)).toBeLessThanOrEqual(16384)
    expect(sanitized.split('\n').filter(Boolean).length).toBeGreaterThan(0)
    expect(sanitized.split('\n').filter(Boolean).length).toBeLessThan(1200)
    expect(sanitized).toContain('Forwarding from 127.0.0.1:18787 -> 8787')
    expect(sanitized).toContain('Handling connection for 18787')
    expect(sanitized).toContain('error: kubectl was unable to forward the requested port (details omitted)')
    expect(sanitized).toContain('round_trippers.go:553 GET path=core-api status=503 elapsed=12 milliseconds')
    expect(sanitized).not.toContain('planted-')
  })

  it('writes only allowlisted sanitized files, stays within the aggregate byte cap, and invokes bounded diagnostic commands', async () => {
    const { directory, env, elapsedMs, netstatBaseline } = await capture()
    const files = await readdir(directory)
    expect(files.sort()).toEqual(['capture.txt', 'listener.txt', 'netstat.txt', 'port-forward.txt', 'versions.txt', 'workloads.txt'])
    const contents = await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))
    const all = contents.join('\n')
    const totalBytes = contents.reduce((total, value) => total + Buffer.byteLength(value), 0)
    expect(totalBytes).toBeLessThanOrEqual(262144)
    expect(all).toContain('Forwarding from 127.0.0.1:18787 -> 8787')
    expect(await readFile(join(directory, 'port-forward.txt'), 'utf8')).toContain(
      'klog I1019 09:42:11.213456 round_trippers.go:553 GET status=503 elapsed=12 milliseconds',
    )
    expect(await readFile(join(directory, 'listener.txt'), 'utf8')).toMatch(/^LISTEN 0 4096 127\.0\.0\.1:18787 0\.0\.0\.0:\*\s*$/m)
    const netstat = await readFile(join(directory, 'netstat.txt'), 'utf8')
    expect(netstat).toContain(`start ${netstatBaseline}`)
    if (procCountersAvailable()) {
      expect(netstat).toMatch(/^end TcpExt ListenOverflows=\d+ ListenDrops=\d+$/m)
      expect(netstat).toMatch(/^delta TcpExt ListenOverflows=\d+ ListenDrops=\d+$/m)
    } else {
      expect(netstat).toContain('end TcpExt ListenOverflows=unavailable ListenDrops=unavailable')
      expect(netstat).toContain('delta TcpExt ListenOverflows=unavailable ListenDrops=unavailable')
    }
    expect(await readFile(join(directory, 'versions.txt'), 'utf8')).toContain('Client Version: v1.32.0')
    expect(await readFile(join(directory, 'versions.txt'), 'utf8')).toContain('kind v0.25.0')
    expect(await readFile(join(directory, 'versions.txt'), 'utf8')).toContain('containerd github.com/containerd/containerd v2.0.0')
    expect(all).toContain('Pod current-pod uid=pod-uid ownerRS=rs-uid phase=Running ready=True')
    expect(all).toContain('ReplicaSet current-rs uid=rs-uid ownerDeployment=deployment-uid revision=7 desired=1')
    expect(all).not.toMatch(/planted-|Authorization|https:|certificate-authority-data|clusters:/i)
    expect(elapsedMs).toBeLessThan(8000)
    const calls = await readFile(env.CAPTURE_ARGV_LOG!, 'utf8')
    expect(calls).toContain('kubectl version --client')
    expect(calls).toContain('kubectl --context kind-test --namespace openkubes-console get pods')
    expect(calls).toContain('kubectl --context kind-test --namespace openkubes-console get replicasets')
    expect(calls).toContain('kind version')
    expect(calls).toContain('docker exec test-control-plane containerd --version')
    expect(calls).toContain('ss -ltn sport = :18787')
  })

  it('normalizes the requested TCP listener from lsof when ss is absent', async () => {
    const path = join(fixtureDirectory, 'lsof-tools-bin')
    const { directory, env } = await capture('normal', undefined, undefined, path)
    const listener = await readFile(join(directory, 'listener.txt'), 'utf8')
    expect(listener).toBe('TCP 127.0.0.1:18787 (LISTEN)\n')
    expect(listener).toMatch(/127\.0\.0\.1:18787/)
    expect(listener).not.toContain('9999')
    expect(listener).not.toContain('user')
    expect(await readFile(env.CAPTURE_ARGV_LOG!, 'utf8')).toContain('lsof -nP -iTCP:18787 -sTCP:LISTEN')
  })

  it('records an explicit unavailable listener when both ss and lsof are absent', async () => {
    const path = join(fixtureDirectory, 'no-listener-tools-bin')
    const { directory } = await capture('normal', undefined, undefined, path)
    expect(await readFile(join(directory, 'listener.txt'), 'utf8')).toContain('unavailable: neither ss nor lsof is installed')
  })

  it('continues after a diagnostic command times out and keeps total capture runtime bounded', async () => {
    const { directory, elapsedMs, env } = await capture('slow')
    expect(await readFile(env.CAPTURE_SLOW_MARKER!, 'utf8')).toBe('started\n')
    expect(elapsedMs).toBeGreaterThanOrEqual(2500)
    expect(elapsedMs).toBeLessThan(8500)
    expect(await readFile(join(directory, 'capture.txt'), 'utf8')).toContain('Total capture budget: 26s')
    expect(await readFile(join(directory, 'versions.txt'), 'utf8')).toContain('Client Version: v1.32.0')
  }, 10000)
})
