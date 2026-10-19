// @vitest-environment node

import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const helper = fileURLToPath(new URL('./capture-local-kind-failure.sh', import.meta.url))
let fixtureDirectory = ''
let execution = 0

const kubectlStub = `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'kubectl %s\\n' "$*" >>"$CAPTURE_ARGV_LOG"
case "$*" in
  'version --client')
    printf 'Client Version: v1.32.0\\n'
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

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'ok-console-ok200-capture-'))
  for (const [name, contents] of Object.entries({ kubectl: kubectlStub, kind: kindStub, docker: dockerStub, ss: ssStub })) {
    await writeFile(join(fixtureDirectory, name), contents)
    await chmod(join(fixtureDirectory, name), 0o755)
  }
})

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true })
})

const environment = (scenario = 'normal') => {
  const id = execution++
  return {
    ...process.env,
    PATH: `${fixtureDirectory}:${process.env.PATH}`,
    CAPTURE_ARGV_LOG: join(fixtureDirectory, `argv-${id}.log`),
    CAPTURE_SCENARIO: scenario,
    CAPTURE_SLOW_MARKER: join(fixtureDirectory, `slow-marker-${id}`),
  }
}

const capture = async (scenario = 'normal', suppliedNetstatBaseline?: string) => {
  const env = environment(scenario)
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

describe('OK-200 failure diagnostic capture', () => {
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
    expect(sanitized).toContain('round_trippers.go:553 GET status=503 elapsed=12 milliseconds')
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
    expect(stdout).toMatch(/^TcpExt ListenOverflows=\d+ ListenDrops=\d+\n$/)
  })

  it('preserves valid start and end counters when a decreasing counter makes the delta unavailable', async () => {
    const baseline = 'TcpExt ListenOverflows=999999999999 ListenDrops=999999999999'
    const { directory } = await capture('normal', baseline)
    const netstat = await readFile(join(directory, 'netstat.txt'), 'utf8')
    expect(netstat).toContain(`start ${baseline}`)
    expect(netstat).toMatch(/^end TcpExt ListenOverflows=\d+ ListenDrops=\d+$/m)
    expect(netstat).toContain('delta TcpExt ListenOverflows=unavailable ListenDrops=unavailable')
  })

  it('keeps a missing verification-start counter unavailable instead of fabricating a failure-time baseline', async () => {
    const unavailable = 'TcpExt ListenOverflows=unavailable ListenDrops=unavailable'
    const { directory } = await capture('normal', unavailable)
    const netstat = await readFile(join(directory, 'netstat.txt'), 'utf8')
    expect(netstat).toContain(`start ${unavailable}`)
    expect(netstat).toMatch(/^end TcpExt ListenOverflows=\d+ ListenDrops=\d+$/m)
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
    expect(sanitized).toContain('round_trippers.go:553 GET status=503 elapsed=12 milliseconds')
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
    expect(netstat).toMatch(/^end TcpExt ListenOverflows=\d+ ListenDrops=\d+$/m)
    expect(netstat).toMatch(/^delta TcpExt ListenOverflows=\d+ ListenDrops=\d+$/m)
    expect(await readFile(join(directory, 'versions.txt'), 'utf8')).toContain('Client Version: v1.32.0')
    expect(await readFile(join(directory, 'versions.txt'), 'utf8')).toContain('kind v0.25.0')
    expect(await readFile(join(directory, 'versions.txt'), 'utf8')).toContain('containerd github.com/containerd/containerd v2.0.0')
    expect(all).toContain('Pod current-pod uid=pod-uid ownerRS=rs-uid phase=Running ready=True')
    expect(all).toContain('ReplicaSet current-rs uid=rs-uid ownerDeployment=deployment-uid revision=7 desired=1')
    expect(all).not.toMatch(/planted-|Authorization|https:|certificate-authority-data|clusters:/i)
    expect(elapsedMs).toBeLessThan(5000)
    const calls = await readFile(env.CAPTURE_ARGV_LOG!, 'utf8')
    expect(calls).toContain('kubectl version --client')
    expect(calls).toContain('kubectl --context kind-test --namespace openkubes-console get pods')
    expect(calls).toContain('kubectl --context kind-test --namespace openkubes-console get replicasets')
    expect(calls).toContain('kind version')
    expect(calls).toContain('docker exec test-control-plane containerd --version')
    expect(calls).toContain('ss -ltn sport = :18787')
  })

  it('continues after a diagnostic command times out and keeps total capture runtime bounded', async () => {
    const { directory, elapsedMs, env } = await capture('slow')
    expect(await readFile(env.CAPTURE_SLOW_MARKER!, 'utf8')).toBe('started\n')
    expect(elapsedMs).toBeGreaterThanOrEqual(2500)
    expect(elapsedMs).toBeLessThan(6000)
    expect(await readFile(join(directory, 'capture.txt'), 'utf8')).toContain('Total capture budget: 26s')
    expect(await readFile(join(directory, 'versions.txt'), 'utf8')).toContain('Client Version: v1.32.0')
  }, 10000)
})
