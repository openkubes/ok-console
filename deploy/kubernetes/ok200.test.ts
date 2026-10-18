// @vitest-environment node

import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const checkedInVerifier = fileURLToPath(new URL('./verify-local-kind.sh', import.meta.url))
const verifier = process.env.OK200_VERIFIER_UNDER_TEST ?? checkedInVerifier
let fixtureDirectory = ''
let execution = 0

const kubectlStub = `#!/usr/bin/env bash
set -Eeuo pipefail
fail() { printf 'unexpected kubectl invocation: %s\\n' "$*" >&2; exit 2; }
if [[ "\${1:-}" == kustomize ]]; then
  [[ "$#" == 2 ]] || fail "$@"
  printf 'apiVersion: v1\\nkind: Pod\\nspec:\\n  containers:\\n    - image: ok-console:ok-169-local\\n'
  exit 0
fi
[[ "\${1:-}" == --context && "\${2:-}" == kind-test ]] || fail "$@"
if [[ "\${3:-}" == apply ]]; then
  [[ "\${4:-}" == -f && "$#" == 5 ]] || fail "$@"
  exit 0
fi
[[ "\${3:-}" == --namespace && "\${4:-}" == openkubes-console ]] || fail "$@"
shift 4
if [[ " $* " == *" get deployment ok-console "* ]]; then
  if [[ "$*" == *'.spec.template.spec.containers[0].image'* ]]; then
    printf '%s' "\${OK_CONSOLE_IMAGE}"
  elif [[ "$*" == *'.spec.template.spec.automountServiceAccountToken'* ]]; then
    printf 'false true true false ALL'
  else
    printf 'deployment-uid|7\\n'
  fi
elif [[ " $* " == *" get replicasets "* ]]; then
  case "\${KUBECTL_SCENARIO}" in
    no-current-rs) printf 'old-rs|old-uid|6|deployment-uid\\nunrelated-rs|unrelated-uid|7|other-deployment-uid\\n' ;;
    multiple-current-rs) printf 'current-rs|current-uid|7|deployment-uid\\nduplicate-rs|duplicate-uid|7|deployment-uid\\n' ;;
    *) printf 'old-rs|old-uid|6|deployment-uid\\nunrelated-rs|unrelated-uid|7|other-deployment-uid\\ncurrent-rs|current-uid|7|deployment-uid\\n' ;;
  esac
elif [[ " $* " == *" get pods "* ]]; then
  case "\${KUBECTL_SCENARIO}" in
    no-current) printf 'unrelated-pod|unrelated-uid|True||Running\\n' ;;
    multiple) printf 'ready-pod|current-uid|True||Running\\nstarting-pod|current-uid|False||Pending\\n' ;;
    deleting) printf 'deleting-pod|current-uid|True|2026-10-18T00:00:00Z|Running\\n' ;;
    not-ready) printf 'starting-pod|current-uid|False||Running\\n' ;;
    old-leftover) printf 'current-pod|current-uid|True||Running\\nold-pod|old-uid|True||Running\\n' ;;
    old-transition)
      if [[ -e "\${KUBECTL_STATE}" ]]; then
        printf 'current-pod|current-uid|True||Running\\n'
      else
        : > "\${KUBECTL_STATE}"
        printf 'current-pod|current-uid|True||Running\\nold-pod|old-uid|True||Running\\n'
      fi
      ;;
    valid|main-forward-fail|main-transient|main-persistent-failure|main-forward-exit) printf 'current-pod|current-uid|True||Running\\n' ;;
    *) printf 'unknown scenario: %s\\n' "\${KUBECTL_SCENARIO}" >&2; exit 2 ;;
  esac
elif [[ "\${1:-}" == port-forward ]]; then
  [[ "$#" == 5 && "\${2:-}" == --address && "\${3:-}" == 127.0.0.1 && "\${4:-}" == pod/current-pod && "\${5:-}" =~ ^[0-9]+:8787$ ]] || fail "$@"
  : > "\${KUBECTL_STARTED}"
  exec node "\${KUBECTL_BINDER}" "$@"
elif [[ "\${1:-}" == rollout && ( "\${2:-}" == status || "\${2:-}" == restart ) && "\${3:-}" == deployment/ok-console ]]; then
  :
elif [[ "\${1:-}" == get && "\${2:-}" == pod && "\${3:-}" == current-pod ]]; then
  printf 'docker-pullable://ok-console@sha256:test'
elif [[ "\${1:-}" == exec && "\${2:-}" == current-pod ]]; then
  printf 'production'
else
  fail "$@"
fi
`

const binderStub = `const net = require('node:net')
const fs = require('node:fs')
const args = process.argv.slice(2)
const mapping = args.find((argument) => /^\\d+:8787$/.test(argument))
const port = Number(mapping?.split(':')[0])
if (process.env.KUBECTL_SCENARIO === 'process-exit' || process.env.KUBECTL_SCENARIO === 'main-forward-fail') {
  console.error('unable to upgrade connection: pod not found')
  process.exit(42)
}
if (process.env.KUBECTL_SCENARIO === 'main-forward-exit') fs.writeFileSync(process.env.KUBECTL_PID, String(process.pid))
const server = net.createServer()
server.once('error', (error) => {
  console.error('Unable to listen on port ' + port + ': ' + error.message)
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => {
  let line = ''
  if (process.env.KUBECTL_SCENARIO === 'ready' || process.env.KUBECTL_SCENARIO.startsWith('main-') || process.env.KUBECTL_SCENARIO === 'line-then-exit') {
    line = 'Forwarding from 127.0.0.1:' + port + ' -> 8787'
  } else if (process.env.KUBECTL_SCENARIO === 'wrong-port') {
    line = 'Forwarding from 127.0.0.1:' + (port + 1) + ' -> 8787'
  } else if (process.env.KUBECTL_SCENARIO === 'wrong-port-prefix') {
    line = 'Forwarding from 127.0.0.1:' + port + '0 -> 8787'
  } else if (process.env.KUBECTL_SCENARIO === 'wrong-address') {
    line = 'Forwarding from [::1]:' + port + ' -> 8787'
  }
  if (line) {
    if (process.env.EVENT_LOG) fs.appendFileSync(process.env.EVENT_LOG, 'forward:' + line + '\\n')
    console.log(line)
  }
  if (process.env.KUBECTL_SCENARIO === 'line-then-exit') server.close(() => process.exit(43))
})
process.on('SIGTERM', () => {
  if (process.env.KUBECTL_SCENARIO === 'main-forward-exit') console.error('forwarder terminated after first live probe')
  server.close(() => process.exit(0))
})
setTimeout(() => process.exit(3), 5000)
`

const dockerStub = `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\${1:-}" == image && "\${2:-}" == inspect && " $* " == *" --format "* ]]; then
  printf '%s' "\${OK_CONSOLE_EXPECTED_REVISION}"
elif [[ "\${1:-}" == image && "\${2:-}" == inspect ]]; then
  :
else
  printf 'unexpected docker invocation: %s\\n' "$*" >&2
  exit 2
fi
`

const kindStub = `#!/usr/bin/env bash
set -Eeuo pipefail
case "\${1:-} \${2:-}" in
  'get clusters') : ;;
  'create cluster'|'load docker-image'|'delete cluster') : ;;
  *) printf 'unexpected kind invocation: %s\\n' "$*" >&2; exit 2 ;;
esac
`

const gitStub = `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ " $* " == *" rev-parse HEAD "* ]]; then
  printf '%s\\n' "\${OK_CONSOLE_EXPECTED_REVISION}"
elif [[ " $* " == *" rev-parse --short=12 HEAD "* ]]; then
  printf '0123456789ab\\n'
else
  printf 'unexpected git invocation: %s\\n' "$*" >&2
  exit 2
fi
`

const curlStub = `#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$#" == 6 && "\${1:-}" == --fail && "\${2:-}" == --silent && "\${3:-}" == --show-error && "\${4:-}" == --max-time && "\${5:-}" == 5 ]] || {
  printf 'unexpected curl invocation: %s\\n' "$*" >&2
  exit 2
}
url="\${6}"
path="/\${url#http://127.0.0.1:*/}"
[[ "\${url}" == "http://127.0.0.1:\${OK_CONSOLE_LOCAL_PORT}\${path}" ]] || {
  printf 'unexpected curl URL: %s\\n' "\${url}" >&2
  exit 2
}
printf '%s\\n' "\${path}" >> "\${CURL_LOG}"
printf 'curl:%s\\n' "\${path}" >> "\${EVENT_LOG}"
if [[ "\${path}" == /health/live ]]; then
  attempts=0
  [[ ! -f "\${CURL_STATE}" ]] || attempts="$(<"\${CURL_STATE}")"
  attempts=$((attempts + 1))
  printf '%s' "\${attempts}" > "\${CURL_STATE}"
  if [[ "\${KUBECTL_SCENARIO}" == main-forward-exit ]]; then
    kill -TERM "$(<"\${KUBECTL_PID}")"
    exit 7
  fi
  if [[ "\${KUBECTL_SCENARIO}" == main-persistent-failure || ( "\${KUBECTL_SCENARIO}" == main-transient && "\${attempts}" == 1 ) ]]; then
    exit 7
  fi
fi
`

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'ok-console-ok200-'))
  const files = new Map([
    ['kubectl', kubectlStub],
    ['binder.cjs', binderStub],
    ['docker', dockerStub],
    ['kind', kindStub],
    ['git', gitStub],
    ['curl', curlStub],
    ['sleep', '#!/usr/bin/env bash\nif [[ "${KUBECTL_SCENARIO}" == main-forward-exit ]]; then /bin/sleep 0.1; fi\n'],
  ])
  await Promise.all([...files].map(([name, contents]) => writeFile(join(fixtureDirectory, name), contents)))
  await Promise.all([...files.keys()].filter((name) => name !== 'binder.cjs').map((name) => chmod(join(fixtureDirectory, name), 0o755)))
})

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true })
})

const environment = (scenario: string) => {
  const id = execution++
  return {
    ...process.env,
    PATH: `${fixtureDirectory}:${process.env.PATH}`,
    KUBECTL_SCENARIO: scenario,
    KUBECTL_BINDER: join(fixtureDirectory, 'binder.cjs'),
    KUBECTL_STATE: join(fixtureDirectory, `kubectl-state-${id}`),
    KUBECTL_PID: join(fixtureDirectory, `kubectl-pid-${id}`),
    KUBECTL_STARTED: join(fixtureDirectory, `kubectl-started-${id}`),
    CURL_STATE: join(fixtureDirectory, `curl-state-${id}`),
    CURL_LOG: join(fixtureDirectory, `curl-log-${id}`),
    EVENT_LOG: join(fixtureDirectory, `event-log-${id}`),
    OK_CONSOLE_KIND_CLUSTER: 'test',
    OK_CONSOLE_IMAGE: 'ok-console:test',
    OK_CONSOLE_EXPECTED_REVISION: '0123456789abcdef0123456789abcdef01234567',
  }
}

const selectPod = (scenario: string, deadlineEdge = false) => {
  const override = deadlineEdge
    ? 'read() { builtin read "$@"; status=$?; if (( status == 0 )) && [[ "${found_pod_name:-}" == current-pod && -n "${deadline:-}" ]]; then SECONDS="${deadline}"; fi; return "${status}"; };'
    : ''
  return exec(
    'bash',
    ['-c', `source "$1"; ${override} cluster_name=test; select_current_pod 3 0.01`, '_', verifier],
    { env: environment(scenario), timeout: 6000, killSignal: 'SIGKILL' },
  )
}

const unusedPort = async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port.')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

const waitForForward = async (scenario: string, port: number, timeoutSeconds = 2, staleLog = false) => {
  const log = join(fixtureDirectory, `port-forward-${scenario}-${port}.log`)
  const readOverride = scenario === 'line-then-exit'
    ? 'read() { builtin read "$@"; status=$?; if (( status == 0 )) && [[ "${observed_line:-}" == "${expected_line:-}" ]]; then wait "${port_forward_pid}" || true; fi; return "${status}"; }'
    : staleLog
      ? 'read() { while [[ ! -e "${KUBECTL_STARTED}" ]]; do :; done; builtin read "$@"; }'
      : ''
  const command = [
    'source "$1"',
    readOverride,
    'cluster_name=test',
    'pod_name=current-pod',
    'local_port="$2"',
    'port_forward_log="$3"',
    'set +e',
    'start_and_wait_for_port_forward "$4" 0.01',
    'status=$?',
    'if [[ -n "${port_forward_pid}" ]]; then kill "${port_forward_pid}" 2>/dev/null || true; wait "${port_forward_pid}" 2>/dev/null || true; fi',
    'exit "${status}"',
  ].filter(Boolean).join('; ')
  await writeFile(log, staleLog ? `Forwarding from 127.0.0.1:${port} -> 8787\n` : '')
  return exec('bash', ['-c', command, '_', verifier, String(port), log, String(timeoutSeconds)], {
    env: environment(scenario),
    timeout: 6000,
    killSignal: 'SIGKILL',
  })
}

const runMain = async (scenario: string) => {
  const port = await unusedPort()
  const env = { ...environment(scenario), OK_CONSOLE_LOCAL_PORT: String(port) }
  try {
    const result = await exec(verifier, [], { env, timeout: 10000, killSignal: 'SIGKILL' })
    return { ...result, env }
  } catch (error) {
    throw Object.assign(error as object, { env })
  }
}

describe('OK-200 current ReplicaSet Pod selection', () => {
  it('rejects an unknown kubectl scenario instead of selecting a valid Pod', async () => {
    await expect(exec('kubectl', ['--context', 'kind-test', '--namespace', 'openkubes-console', 'get', 'pods'], {
      env: environment('vlaid'),
    })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('unknown scenario: vlaid'),
    })
  })

  it('accepts exactly one Ready, non-terminating current Pod', async () => {
    const result = await selectPod('valid')
    expect(result.stdout).toContain('Selected Pod current-pod of ReplicaSet current-rs')
  })

  it('accepts after an old ReplicaSet Pod disappears within the deadline', async () => {
    const result = await selectPod('old-transition')
    expect(result.stdout).toContain('Selected Pod current-pod of ReplicaSet current-rs')
  })

  it('accepts a successful final observation made exactly at the deadline', async () => {
    const result = await selectPod('valid', true)
    expect(result.stdout).toContain('Selected Pod current-pod of ReplicaSet current-rs')
  })

  it.each([
    ['no-current', 'Expected exactly one Pod of current ReplicaSet current-rs; found 0'],
    ['multiple', 'Expected exactly one Pod of current ReplicaSet current-rs; found 2'],
    ['deleting', 'must be Ready and non-terminating'],
    ['not-ready', 'must be Ready and non-terminating'],
    ['old-leftover', 'Timed out after 3s waiting for Pods of old ReplicaSets'],
    ['no-current-rs', 'Expected exactly one ReplicaSet for Deployment ok-console revision 7; found 0'],
    ['multiple-current-rs', 'Expected exactly one ReplicaSet for Deployment ok-console revision 7; found 2'],
  ])('rejects %s Pod state', async (scenario, cause) => {
    await expect(selectPod(scenario)).rejects.toMatchObject({ stderr: expect.stringContaining(cause) })
  }, 7000)
})

describe('OK-200 port-forward readiness', () => {
  it('accepts only kubectl readiness for the exact IPv4 port', async () => {
    await expect(waitForForward('ready', await unusedPort())).resolves.toMatchObject({ stderr: '' })
  })

  it.each([
    ['missing-line', 'Timed out waiting for kubectl port-forward to report'],
    ['wrong-port', 'reported an unexpected forwarding endpoint'],
    ['wrong-port-prefix', 'reported an unexpected forwarding endpoint'],
    ['wrong-address', 'reported an unexpected forwarding endpoint'],
  ])('rejects %s with its cause', async (scenario, cause) => {
    await expect(waitForForward(scenario, await unusedPort(), scenario === 'missing-line' ? 1 : 2))
      .rejects.toMatchObject({ stderr: expect.stringContaining(cause) })
  }, 5000)

  it('reports the captured kubectl diagnostic when the process exits', async () => {
    await expect(waitForForward('process-exit', await unusedPort(), 2)).rejects.toMatchObject({
      stderr: expect.stringMatching(/exited before reporting readiness[\s\S]*unable to upgrade connection: pod not found/),
    })
  })

  it('rejects a forwarder that exits immediately after its readiness line', async () => {
    await expect(waitForForward('line-then-exit', await unusedPort(), 2)).rejects.toMatchObject({
      stderr: expect.stringContaining('exited immediately after reporting readiness'),
    })
  })

  it('truncates a stale readiness line before observing the new forwarder', async () => {
    await expect(waitForForward('missing-line', await unusedPort(), 1, true)).rejects.toMatchObject({
      stderr: expect.stringContaining('Timed out waiting for kubectl port-forward to report'),
    })
  })

  it('rejects a pre-existing IPv4 listener and never treats it as tunnel readiness', async () => {
    const listener = createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Could not bind the occupied test port.')
    try {
      await expect(waitForForward('ready', address.port)).rejects.toMatchObject({
        stderr: expect.stringMatching(/exited before reporting readiness[\s\S]*EADDRINUSE/),
      })
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
    }
  }, 5000)
})

describe('OK-200 main verification flow', () => {
  it('fails fast with the forwarder log and stops curl attempts when forwarding dies during retries', async () => {
    const started = performance.now()
    const run = runMain('main-forward-exit')
    await expect(run).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/port-forward exited during live health probing[\s\S]*Forwarding from 127\.0\.0\.1:\d+ -> 8787[\s\S]*forwarder terminated after first live probe/),
    })
    expect(performance.now() - started).toBeLessThan(3000)
    const failure = await run.catch((error: { env: NodeJS.ProcessEnv }) => error)
    expect(await readFile(failure.env.CURL_LOG!, 'utf8')).toBe('/health/live\n')
    expect(await readFile(failure.env.CURL_STATE!, 'utf8')).toBe('1')
  })

  it('fails before any HTTP probe when port-forward readiness fails', async () => {
    const run = runMain('main-forward-fail')
    await expect(run).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('exited before reporting readiness'),
    })
    const failure = await run.catch((error: { env: NodeJS.ProcessEnv }) => error)
    await expect(readFile(failure.env.CURL_LOG!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('waits for forwarding, retries a transient live failure, then probes ready and root', async () => {
    const result = await runMain('main-transient')
    const events = (await readFile(result.env.EVENT_LOG!, 'utf8')).trim().split('\n')
    expect(events[0]).toMatch(/^forward:Forwarding from 127\.0\.0\.1:\d+ -> 8787$/)
    expect(events.slice(1)).toEqual([
      'curl:/health/live',
      'curl:/health/live',
      'curl:/health/ready',
      'curl:/',
    ])
    expect(result.stdout).toContain('OK-169 local Kubernetes deployment proof passed.')
  })

  it('stops after 30 bounded live failures without probing ready or root', async () => {
    const run = runMain('main-persistent-failure')
    await expect(run).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Live health probe failed after 30 attempts (5s per attempt).'),
    })
    const failure = await run.catch((error: { env: NodeJS.ProcessEnv }) => error)
    const probes = (await readFile(failure.env.CURL_LOG!, 'utf8')).trim().split('\n')
    expect(probes).toHaveLength(30)
    expect(probes.every((probe) => probe === '/health/live')).toBe(true)
  })
})
