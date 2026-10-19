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

const capture = async (scenario = 'normal') => {
  const env = environment(scenario)
  const directory = join(fixtureDirectory, `artifacts-${execution}`)
  await mkdir(directory)
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
  const result = await exec('bash', [helper, 'capture', directory, 'test', '18787', 'current-pod', '9', forwardLog], {
    env,
    timeout: 10000,
    killSignal: 'SIGKILL',
  })
  return { directory, env, elapsedMs: performance.now() - started, result }
}

describe('OK-200 failure diagnostic capture', () => {
  it('filters port-forward output to useful bounded lines and drops bearer, URL, and kubeconfig material', async () => {
    const output = join(fixtureDirectory, 'filtered-forward.log')
    const input = [
      'Forwarding from 127.0.0.1:18787 -> 8787',
      'Handling connection for 18787',
      'error: unable to forward connection: connection refused',
      'I1019 09:42:11.213456       1 round_trippers.go:553] GET https://api.internal.invalid/api/v1/pods?token=planted-trace-token 503 Service Unavailable in 12 milliseconds',
      'I1019 09:42:11.213456       1 portforward.go:406] GET https://api.internal.invalid/api/v1/pods?token=planted-portforward-trace-token (503) 12ms',
      'Authorization: Bearer planted-filter-bearer',
      'https://internal.example.invalid/path?token=planted-filter-url',
      'apiVersion: v1',
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
    expect(sanitized).toContain('portforward.go:406 GET status=503 elapsed=12ms')
    expect(Buffer.byteLength(sanitized)).toBeLessThanOrEqual(16384)
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
    const { directory, env, elapsedMs } = await capture()
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
    expect(await readFile(join(directory, 'netstat.txt'), 'utf8')).toMatch(/^TcpExt ListenOverflows=\d+ ListenDrops=\d+$/m)
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
