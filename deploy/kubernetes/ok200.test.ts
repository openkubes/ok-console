// @vitest-environment node

import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
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
let missingCurlDirectory = ''
let noTimeoutDirectory = ''
let baselineTraceVerifier = ''
let execution = 0

const kubectlStub = `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'kubectl' >> "\${KUBECTL_ARGV_LOG}"
printf ' <%s>' "$@" >> "\${KUBECTL_ARGV_LOG}"
printf '\n' >> "\${KUBECTL_ARGV_LOG}"
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
if [[ "\${1:-}" == -v=6 ]]; then shift; fi
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
    valid|main-forward-fail|main-transient|main-persistent-failure|main-forward-exit|main-success-cleanup-fail) printf 'current-pod|current-uid|True||Running\\n' ;;
    *) printf 'unknown scenario: %s\\n' "\${KUBECTL_SCENARIO}" >&2; exit 2 ;;
  esac
elif [[ "\${1:-}" == port-forward ]]; then
  [[ "$#" == 5 && "\${2:-}" == --address && "\${3:-}" == 127.0.0.1 && "\${4:-}" == pod/current-pod && "\${5:-}" =~ ^[0-9]+:8787$ ]] || fail "$@"
  : > "\${KUBECTL_STARTED}"
  exec node "\${KUBECTL_BINDER}" "$@"
elif [[ "\${1:-}" == rollout && ( "\${2:-}" == status || "\${2:-}" == restart ) && "\${3:-}" == deployment/ok-console ]]; then
  if [[ "\${KUBECTL_SCENARIO}" == main-rollout-fail || "\${KUBECTL_SCENARIO}" == main-capture-helper-fail || "\${KUBECTL_SCENARIO}" == main-timeout-unavailable || "\${KUBECTL_SCENARIO}" == main-baseline-trace ]]; then
    [[ "\${2:-}" != status ]] || exit 7
  fi
  if [[ "\${KUBECTL_SCENARIO}" == main-status-130 ]]; then
    [[ "\${2:-}" != status ]] || exit 130
  fi
  if [[ "\${KUBECTL_SCENARIO}" == main-status-143 ]]; then
    [[ "\${2:-}" != status ]] || exit 143
  fi
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
  console.error('error: unable to forward connection: pod not found')
  console.error('Authorization: Bearer planted-main-port-forward-bearer')
  console.error('https://internal.example.invalid/?token=planted-main-url-token')
  console.error('apiVersion: v1')
  process.exit(42)
}
if (process.env.KUBECTL_SCENARIO === 'main-forward-exit') fs.writeFileSync(process.env.KUBECTL_PID, String(process.pid))
const server = net.createServer()
server.once('error', (error) => {
  console.error('unable to listen on port ' + port + ': ' + error.message)
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => {
  let line = ''
  if (process.env.KUBECTL_SCENARIO === 'ready' || process.env.KUBECTL_SCENARIO.startsWith('main-') || process.env.KUBECTL_SCENARIO === 'line-then-exit' || process.env.KUBECTL_SCENARIO === 'filter-exit') {
    line = 'Forwarding from 127.0.0.1:' + port + ' -> 8787'
  } else if (process.env.KUBECTL_SCENARIO === 'wrong-port') {
    line = 'Forwarding from 127.0.0.1:' + (port + 1) + ' -> 8787'
  } else if (process.env.KUBECTL_SCENARIO === 'wrong-port-prefix') {
    line = 'Forwarding from 127.0.0.1:' + port + '0 -> 8787'
  } else if (process.env.KUBECTL_SCENARIO === 'wrong-address') {
    line = 'Forwarding from [::1]:' + port + ' -> 8787'
  } else if (process.env.KUBECTL_SCENARIO === 'wrong-target') {
    line = 'Forwarding from 127.0.0.1:' + port + ' -> 9999'
  } else if (process.env.KUBECTL_SCENARIO === 'trailing-readiness') {
    line = 'Forwarding from 127.0.0.1:' + port + ' -> 8787 trailing-data'
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
printf 'docker' >> "\${DOCKER_ARGV_LOG}"
printf ' <%s>' "$@" >> "\${DOCKER_ARGV_LOG}"
printf '\n' >> "\${DOCKER_ARGV_LOG}"
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
printf 'kind' >> "\${KIND_ARGV_LOG}"
printf ' <%s>' "$@" >> "\${KIND_ARGV_LOG}"
printf '\n' >> "\${KIND_ARGV_LOG}"
case "\${1:-} \${2:-}" in
  'get clusters') [[ "\${KUBECTL_SCENARIO}" != preflight-already-exists ]] || printf 'test\\n' ;;
  'create cluster')
    if [[ "\${KUBECTL_SCENARIO}" == main-baseline-trace ]]; then printf 'kind-create\n' >> "\${BASELINE_TRACE}"; fi
    : ;;
  'load docker-image') : ;;
  'delete cluster')
    [[ "\${KUBECTL_SCENARIO}" != main-rollout-fail ]] || exit 9
    [[ "\${KUBECTL_SCENARIO}" != main-success-cleanup-fail ]] || exit 8
    : ;;
  'version ')
    if [[ "\${KUBECTL_SCENARIO}" == main-rollout-fail ]]; then
      printf 'started\\n' >"\${KIND_CAPTURE_MARKER}"
      trap '' TERM
      exec /bin/sleep 8
    fi
    if [[ "\${KUBECTL_SCENARIO}" == main-capture-helper-fail ]]; then
      printf 'started\\n' >"\${KIND_CAPTURE_MARKER}"
      exit 9
    fi
    printf 'kind v0.25.0 go1.23.0 linux/amd64\\n' ;;
  *) printf 'unexpected kind invocation: %s\\n' "$*" >&2; exit 2 ;;
esac
`

const gitStub = `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ " $* " == *" rev-parse HEAD "* ]]; then
  printf '%s\\n' "\${OK_CONSOLE_EXPECTED_REVISION}"
elif [[ " $* " == *" rev-parse --short=12 HEAD "* ]]; then
  printf '0123456789ab\\n'
elif [[ " $* " == *" status --porcelain --untracked-files=normal "* ]]; then
  [[ "\${KUBECTL_SCENARIO}" != preflight-dirty ]] || printf ' M src/App.tsx\\n'
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

const captureRecorderStub = `#!/usr/bin/env bash
set -Eeuo pipefail
case "\${1:-}" in
  snapshot-netstat)
    printf 'snapshot\n' >> "\${BASELINE_TRACE}"
    printf 'TcpExt ListenOverflows=11 ListenDrops=7\n'
    ;;
  capture)
    printf 'capture:%s\n' "\${8:-missing}" >> "\${BASELINE_TRACE}"
    printf '<%s>\n' "$@" > "\${CAPTURE_HELPER_ARGV}"
    ;;
  *) exit 2 ;;
esac
`

const createIsolatedToolDirectory = async (name: string, omitted: string) => {
  const directory = join(fixtureDirectory, name)
  await mkdir(directory)
  const tools = new Map([
    ['bash', '/bin/bash'],
    ['dirname', '/usr/bin/dirname'],
    ['mktemp', '/usr/bin/mktemp'],
    ['rm', '/usr/bin/rm'],
    ['sed', '/usr/bin/sed'],
    ['grep', '/usr/bin/grep'],
    ['awk', '/usr/bin/awk'],
    ['docker', join(fixtureDirectory, 'docker')],
    ['kind', join(fixtureDirectory, 'kind')],
    ['kubectl', join(fixtureDirectory, 'kubectl')],
    ['curl', join(fixtureDirectory, 'curl')],
    ['git', join(fixtureDirectory, 'git')],
    ['sleep', join(fixtureDirectory, 'sleep')],
    ['timeout', join(fixtureDirectory, 'timeout')],
  ])
  await Promise.all([...tools]
    .filter(([tool]) => tool !== omitted)
    .map(([tool, target]) => symlink(target, join(directory, tool))))
  return directory
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'ok-console-ok200-'))
  const files = new Map([
    ['kubectl', kubectlStub],
    ['binder.cjs', binderStub],
    ['docker', dockerStub],
    ['kind', kindStub],
    ['git', gitStub],
    ['curl', curlStub],
    ['capture-recorder', captureRecorderStub],
    ['timeout', `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\${1:-}" == --signal=TERM && "\${3:-}" == 29s ]]; then
  printf 'capture-started\\n' >> "\${CAPTURE_OUTER_MARKER}"
fi
if [[ "\${KUBECTL_SCENARIO}" == main-capture-helper-fail && "\${1:-}" == --signal=TERM && "\${3:-}" == 29s ]]; then
  printf 'outer-helper-failed\\n' >"\${CAPTURE_OUTER_MARKER}"
  exit 42
fi
exec /usr/bin/timeout "$@"
`],
    ['sleep', '#!/usr/bin/env bash\nif [[ "${KUBECTL_SCENARIO}" == main-forward-exit ]]; then /bin/sleep 0.1; fi\n'],
  ])
  await Promise.all([...files].map(([name, contents]) => writeFile(join(fixtureDirectory, name), contents)))
  await Promise.all([...files.keys()].filter((name) => name !== 'binder.cjs').map((name) => chmod(join(fixtureDirectory, name), 0o755)))
  missingCurlDirectory = await createIsolatedToolDirectory('missing-curl-bin', 'curl')
  noTimeoutDirectory = await createIsolatedToolDirectory('no-timeout-bin', 'timeout')
  const traceDirectory = join(fixtureDirectory, 'baseline-trace-verifier')
  await mkdir(traceDirectory)
  baselineTraceVerifier = join(traceDirectory, 'verify-local-kind.sh')
  await copyFile(checkedInVerifier, baselineTraceVerifier)
  await symlink(join(fixtureDirectory, 'capture-recorder'), join(traceDirectory, 'capture-local-kind-failure.sh'))
})

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true })
})

const environment = (scenario: string, temporaryDirectory = fixtureDirectory) => {
  const id = execution++
  return {
    ...process.env,
    PATH: `${fixtureDirectory}:${process.env.PATH}`,
    TMPDIR: temporaryDirectory,
    KUBECTL_SCENARIO: scenario,
    KIND_CAPTURE_MARKER: join(fixtureDirectory, `kind-capture-${id}`),
    KIND_ARGV_LOG: join(fixtureDirectory, `kind-argv-${id}`),
    KUBECTL_ARGV_LOG: join(fixtureDirectory, `kubectl-argv-${id}`),
    DOCKER_ARGV_LOG: join(fixtureDirectory, `docker-argv-${id}`),
    CAPTURE_OUTER_MARKER: join(fixtureDirectory, `capture-outer-${id}`),
    CAPTURE_HELPER_ARGV: join(fixtureDirectory, `capture-helper-argv-${id}`),
    KUBECTL_BINDER: join(fixtureDirectory, 'binder.cjs'),
    KUBECTL_STATE: join(fixtureDirectory, `kubectl-state-${id}`),
    KUBECTL_PID: join(fixtureDirectory, `kubectl-pid-${id}`),
    KUBECTL_STARTED: join(fixtureDirectory, `kubectl-started-${id}`),
    CURL_STATE: join(fixtureDirectory, `curl-state-${id}`),
    CURL_LOG: join(fixtureDirectory, `curl-log-${id}`),
    EVENT_LOG: join(fixtureDirectory, `event-log-${id}`),
    BASELINE_TRACE: join(fixtureDirectory, `baseline-trace-${id}`),
    OK_CONSOLE_KIND_CLUSTER: 'test',
    OK_CONSOLE_IMAGE: 'ok-console:test',
    OK_CONSOLE_EXPECTED_REVISION: '0123456789abcdef0123456789abcdef01234567',
  }
}

const withTestTempDirectory = async <T>(run: (temporaryDirectory: string) => Promise<T>) => {
  const temporaryDirectory = await mkdtemp(join(fixtureDirectory, 'test-tmp-'))
  try {
    return await run(temporaryDirectory)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
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
    : scenario === 'filter-exit'
      ? 'read() { builtin read "$@"; status=$?; if (( status == 0 )) && [[ "${observed_line:-}" == "${expected_line:-}" ]]; then kill "${port_forward_filter_pid}"; wait "${port_forward_filter_pid}" || true; fi; return "${status}"; }'
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

const runMain = async (
  scenario: string,
  overrides: Record<string, string | undefined> = {},
  path = `${fixtureDirectory}:${process.env.PATH}`,
  verifierPath = verifier,
) => {
  const port = await unusedPort()
  const env: NodeJS.ProcessEnv = { ...environment(scenario), PATH: path, OK_CONSOLE_LOCAL_PORT: String(port) }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  try {
    const result = await exec(verifierPath, [], { env, timeout: 10000, killSignal: 'SIGKILL' })
    return { ...result, env }
  } catch (error) {
    throw Object.assign(error as object, { env })
  }
}

const cleanupFailureArtifact = async (failure: { stderr?: string }) => {
  const directory = failure.stderr?.match(/^Failure diagnostics: (.+)$/m)?.[1]
  if (directory) await rm(directory, { recursive: true, force: true })
}

const expectNoKubectlOrDockerCalls = async (env: NodeJS.ProcessEnv) => {
  await expect(readFile(env.KUBECTL_ARGV_LOG!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(env.DOCKER_ARGV_LOG!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('OK-200 verification preflight', () => {
  it('does not run kubectl or docker when a required tool is missing', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const run = runMain('preflight-missing-tool', { TMPDIR: temporaryDirectory }, missingCurlDirectory)
      await expect(run).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Required command not found: curl'),
      })
      const failure = await run.catch((error: { env: NodeJS.ProcessEnv; stderr: string }) => error)
      await expectNoKubectlOrDockerCalls(failure.env)
      expect(failure.stderr).not.toContain('Failure diagnostics:')
    })
  })

  it('does not run kubectl or docker for a dirty default-image worktree', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const run = runMain('preflight-dirty', { OK_CONSOLE_IMAGE: undefined, TMPDIR: temporaryDirectory })
      await expect(run).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Refusing to label a local image from a dirty worktree'),
      })
      const failure = await run.catch((error: { env: NodeJS.ProcessEnv; stderr: string }) => error)
      await expectNoKubectlOrDockerCalls(failure.env)
      expect(failure.stderr).not.toContain('Failure diagnostics:')
    })
  })

  it('does not run kubectl or docker for an invalid local port', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const run = runMain('preflight-bad-port', { OK_CONSOLE_LOCAL_PORT: '999', TMPDIR: temporaryDirectory })
      await expect(run).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('OK_CONSOLE_LOCAL_PORT must be a four- or five-digit port.'),
      })
      const failure = await run.catch((error: { env: NodeJS.ProcessEnv; stderr: string }) => error)
      await expectNoKubectlOrDockerCalls(failure.env)
      expect(failure.stderr).not.toContain('Failure diagnostics:')
    })
  })

  it('refuses an existing cluster with only the expected Kind lookup argv and no capture', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const run = runMain('preflight-already-exists', { TMPDIR: temporaryDirectory })
      await expect(run).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Kind cluster test already exists; refusing to modify an unowned cluster.'),
      })
      const failure = await run.catch((error: { env: NodeJS.ProcessEnv; stderr: string }) => error)
      await expectNoKubectlOrDockerCalls(failure.env)
      expect(await readFile(failure.env.KIND_ARGV_LOG!, 'utf8')).toBe('kind <get> <clusters>\n')
      expect(failure.stderr).not.toContain('Failure diagnostics:')
    })
  })

  it('passes the verification-start netstat snapshot as the final capture argument', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const env = environment('capture-argv', temporaryDirectory)
      const recorder = join(fixtureDirectory, 'capture-recorder')
      const forwardLog = join(fixtureDirectory, `capture-forward-${execution}.log`)
      await writeFile(forwardLog, '')
      await exec('bash', [
        '-c',
        'source "$1"; failure_capture_helper="$2"; created_cluster=true; cluster_name=test; local_port=18787; pod_name=current-pod; verification_started_seconds="${SECONDS}"; port_forward_log="$3"; netstat_baseline="TcpExt ListenOverflows=11 ListenDrops=7"; capture_failure',
        '_',
        verifier,
        recorder,
        forwardLog,
      ], { env })
      const argv = await readFile(env.CAPTURE_HELPER_ARGV!, 'utf8')
      expect(argv).toMatch(/^<capture>\n<.+>\n<test>\n<18787>\n<current-pod>\n<0>\n/)
      expect(argv).toContain(`<${forwardLog}>\n<TcpExt ListenOverflows=11 ListenDrops=7>\n`)
      const artifactDirectory = argv.split('\n')[1]?.slice(1, -1)
      expect(artifactDirectory).toBeDefined()
      expect(artifactDirectory?.startsWith(`${temporaryDirectory}/`)).toBe(true)
      if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true })
    })
  })
})

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
    ['wrong-target', 'reported an unexpected forwarding endpoint'],
    ['trailing-readiness', 'reported an unexpected forwarding endpoint'],
  ])('rejects %s with its cause', async (scenario, cause) => {
    await expect(waitForForward(scenario, await unusedPort(), scenario === 'missing-line' ? 1 : 2))
      .rejects.toMatchObject({ stderr: expect.stringContaining(cause) })
  }, 5000)

  it('keeps a sanitized diagnostic when the forwarder exits before readiness', async () => {
    const port = await unusedPort()
    await expect(waitForForward('process-exit', port, 2)).rejects.toMatchObject({
      stderr: expect.stringContaining('exited before reporting readiness'),
    })
    const log = await readFile(join(fixtureDirectory, `port-forward-process-exit-${port}.log`), 'utf8')
    expect(log).toContain('error: kubectl was unable to forward the requested port (details omitted)')
    expect(log).not.toMatch(/planted-|Authorization|https:/i)
  })

  it('rejects a forwarder that exits immediately after its readiness line', async () => {
    await expect(waitForForward('line-then-exit', await unusedPort(), 2)).rejects.toMatchObject({
      stderr: expect.stringContaining('exited immediately after reporting readiness'),
    })
  })

  it('rejects an exited output filter while the forwarder remains alive', async () => {
    await expect(waitForForward('filter-exit', await unusedPort(), 2)).rejects.toMatchObject({
      stderr: expect.stringContaining('port-forward output filter exited'),
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
        stderr: expect.stringContaining('exited before reporting readiness'),
      })
      const log = await readFile(join(fixtureDirectory, `port-forward-ready-${address.port}.log`), 'utf8')
      expect(log).toContain('error: kubectl could not listen on the requested port (details omitted)')
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
    }
  }, 5000)
})

describe('OK-200 main verification flow', () => {
  it('fails fast with the forwarder log and stops curl attempts when forwarding dies during retries', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const started = performance.now()
      const run = runMain('main-forward-exit', { TMPDIR: temporaryDirectory })
      await expect(run).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringMatching(/port-forward exited during live health probing[\s\S]*Failure diagnostics:/),
      })
      expect(performance.now() - started).toBeLessThan(8000)
      const failure = await run.catch((error: { env: NodeJS.ProcessEnv; stderr: string }) => error)
      expect(await readFile(failure.env.CURL_LOG!, 'utf8')).toBe('/health/live\n')
      expect(await readFile(failure.env.CURL_STATE!, 'utf8')).toBe('1')
      const directory = failure.stderr.match(/^Failure diagnostics: (.+)$/m)?.[1]
      expect(directory).toBeDefined()
      expect(directory?.startsWith(`${temporaryDirectory}/`)).toBe(true)
      expect(await readFile(join(directory!, 'port-forward.txt'), 'utf8')).toContain('Forwarding from 127.0.0.1:')
      await cleanupFailureArtifact(failure)
    })
  })

  it.each([0, 7])('reports a distinct failure when the output filter dies during a probe returning %s', async (probeStatus) => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const wrapper = join(fixtureDirectory, 'filter-dies-during-probing.sh')
      await writeFile(wrapper, `#!/usr/bin/env bash
source "${verifier}"
curl() {
  printf 'live-probe\\n' >> "$CURL_LOG"
  kill "$port_forward_filter_pid"
  wait "$port_forward_filter_pid" || true
  return ${probeStatus}
}
main "$@"
`)
      await chmod(wrapper, 0o755)
      const run = runMain('main-transient', { TMPDIR: temporaryDirectory }, `${fixtureDirectory}:${process.env.PATH}`, wrapper)
      await expect(run).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('port-forward output filter exited during live health probing'),
      })
      const failure = await run.catch((error: { env: NodeJS.ProcessEnv; stderr: string }) => error)
      expect(failure.stderr).not.toContain('port-forward exited during live health probing')
      expect(failure.stderr).toContain('Failure diagnostics:')
      const directory = failure.stderr.match(/^Failure diagnostics: (.+)$/m)?.[1]
      expect(directory).toBeDefined()
      expect(directory?.startsWith(`${temporaryDirectory}/`)).toBe(true)
      expect(await readFile(failure.env.CURL_LOG!, 'utf8')).toBe('live-probe\n')
      const capture = await readFile(join(directory!, 'capture.txt'), 'utf8')
      expect(capture).toContain('Failure diagnostics for local Kind verification')
      await expect(readFile(join(directory!, 'port-forward.txt'), 'utf8')).resolves.toBeTruthy()
      await cleanupFailureArtifact(failure)
    })
  })

  it('fails before any HTTP probe when port-forward readiness fails', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const run = runMain('main-forward-fail', { TMPDIR: temporaryDirectory })
      await expect(run).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('exited before reporting readiness'),
      })
      const failure = await run.catch((error: { env: NodeJS.ProcessEnv; stderr: string }) => error)
      await expect(readFile(failure.env.CURL_LOG!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      const directory = failure.stderr.match(/^Failure diagnostics: (.+)$/m)?.[1]
      expect(directory).toBeDefined()
      expect(directory?.startsWith(`${temporaryDirectory}/`)).toBe(true)
      const capture = await readFile(join(directory!, 'port-forward.txt'), 'utf8')
      expect(capture).toContain('error: kubectl was unable to forward the requested port (details omitted)')
      expect(capture).not.toMatch(/planted-|Authorization|https:|apiVersion/i)
      const netstat = await readFile(join(directory!, 'netstat.txt'), 'utf8')
      expect(netstat).toMatch(/^start TcpExt ListenOverflows=\d+ ListenDrops=\d+$/m)
      expect(netstat).toMatch(/^delta TcpExt ListenOverflows=\d+ ListenDrops=\d+$/m)
      await cleanupFailureArtifact(failure)
    })
  })

  it('waits for forwarding, retries a transient live failure, then probes ready and root', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const result = await runMain('main-transient', { TMPDIR: temporaryDirectory })
      const events = (await readFile(result.env.EVENT_LOG!, 'utf8')).trim().split('\n')
      expect(events[0]).toMatch(/^forward:Forwarding from 127\.0\.0\.1:\d+ -> 8787$/)
      expect(events.slice(1)).toEqual([
        'curl:/health/live',
        'curl:/health/live',
        'curl:/health/ready',
        'curl:/',
      ])
      expect(result.stdout).toBe([
        'Selected Pod current-pod of ReplicaSet current-rs (Deployment revision 7).',
        'OK-169 local Kubernetes deployment proof passed.',
        'Source revision: 0123456789abcdef0123456789abcdef01234567',
        'Verified image revision: 0123456789abcdef0123456789abcdef01234567',
        'Requested image: ok-console:test',
        'Runtime image ID: docker-pullable://ok-console@sha256:test',
        'Runtime NODE_ENV: production',
        'Runtime security: false true true false ALL',
        `Console URL during verification: http://127.0.0.1:${result.env.OK_CONSOLE_LOCAL_PORT}`,
        'Cluster retained: false',
        '',
      ].join('\n'))
      expect(result.stderr).toBe('')
      await expect(readFile(result.env.CAPTURE_OUTER_MARKER!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(temporaryDirectory)).filter((name) => name.startsWith('ok-console-ok200-failure.'))).toEqual([])
    })
  })

  it('stops after 30 bounded live failures without probing ready or root', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const run = runMain('main-persistent-failure', { TMPDIR: temporaryDirectory })
      await expect(run).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Live health probe failed after 30 attempts (5s per attempt).'),
      })
      const failure = await run.catch((error: { env: NodeJS.ProcessEnv }) => error)
      const probes = (await readFile(failure.env.CURL_LOG!, 'utf8')).trim().split('\n')
      expect(probes).toHaveLength(30)
      expect(probes.every((probe) => probe === '/health/live')).toBe(true)
      expect(failure.stderr).toContain('Failure diagnostics:')
      const directory = failure.stderr.match(/^Failure diagnostics: (.+)$/m)?.[1]
      expect(directory?.startsWith(`${temporaryDirectory}/`)).toBe(true)
      await cleanupFailureArtifact(failure)
    })
  })

  it('preserves a non-1 verification status when capture times out and cluster cleanup fails', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const started = performance.now()
      const run = runMain('main-rollout-fail', { TMPDIR: temporaryDirectory })
      await expect(run).rejects.toMatchObject({ code: 7 })
      const failure = await run.catch((error: { stderr: string; env: NodeJS.ProcessEnv }) => error)
      expect(performance.now() - started).toBeLessThan(8000)
      expect(performance.now() - started).toBeGreaterThanOrEqual(2500)
      expect(await readFile(failure.env.KIND_CAPTURE_MARKER!, 'utf8')).toBe('started\n')
      expect(failure.stderr).toContain('Failure diagnostics:')
      expect(await readFile(failure.env.CAPTURE_OUTER_MARKER!, 'utf8')).toBe('capture-started\n')
      expect(failure.stderr).not.toContain('kind version')
      const directory = failure.stderr.match(/^Failure diagnostics: (.+)$/m)?.[1]
      expect(directory?.startsWith(`${temporaryDirectory}/`)).toBe(true)
      await cleanupFailureArtifact(failure)
    })
  }, 10000)

  it('preserves a non-1 verification status when the outer capture command fails', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const run = runMain('main-capture-helper-fail', { TMPDIR: temporaryDirectory })
      await expect(run).rejects.toMatchObject({ code: 7 })
      const failure = await run.catch((error: { stderr: string; env: NodeJS.ProcessEnv }) => error)
      expect(await readFile(failure.env.CAPTURE_OUTER_MARKER!, 'utf8')).toBe('outer-helper-failed\n')
      expect(failure.stderr).toContain('Failure diagnostics:')
      const directory = failure.stderr.match(/^Failure diagnostics: (.+)$/m)?.[1]
      expect(directory?.startsWith(`${temporaryDirectory}/`)).toBe(true)
      await cleanupFailureArtifact(failure)
    })
  })

  it('preserves verification failure and records a skipped capture when timeout is unavailable', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const run = runMain('main-timeout-unavailable', { TMPDIR: temporaryDirectory }, noTimeoutDirectory)
      await expect(run).rejects.toMatchObject({ code: 7 })
      const failure = await run.catch((error: { stderr: string; env: NodeJS.ProcessEnv }) => error)
      expect(failure.stderr).toContain('timeout unavailable; capture skipped')
      expect(failure.stderr).not.toContain('Failure diagnostics:')
      await expect(readFile(failure.env.CAPTURE_OUTER_MARKER!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(temporaryDirectory)).filter((name) => name.startsWith('ok-console-ok200-failure.'))).toEqual([])
    })
  })

  it('takes the netstat baseline before cluster creation and passes that snapshot to capture', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const run = runMain('main-baseline-trace', { TMPDIR: temporaryDirectory }, `${fixtureDirectory}:${process.env.PATH}`, baselineTraceVerifier)
      await expect(run).rejects.toMatchObject({ code: 7 })
      const failure = await run.catch((error: { stderr: string; env: NodeJS.ProcessEnv }) => error)
      expect(await readFile(failure.env.BASELINE_TRACE!, 'utf8')).toBe([
        'snapshot',
        'kind-create',
        'capture:TcpExt ListenOverflows=11 ListenDrops=7',
        '',
      ].join('\n'))
      const directory = failure.stderr.match(/^Failure diagnostics: (.+)$/m)?.[1]
      expect(directory?.startsWith(`${temporaryDirectory}/`)).toBe(true)
      await cleanupFailureArtifact(failure)
    })
  })

  it.each([
    ['main-status-130', 130],
    ['main-status-143', 143],
  ])('does not capture an interrupted verification for %s', async (scenario, status) => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const run = runMain(scenario, { TMPDIR: temporaryDirectory })
      await expect(run).rejects.toMatchObject({ code: status })
      const failure = await run.catch((error: { stderr: string; env: NodeJS.ProcessEnv }) => error)
      expect(failure.stderr).not.toContain('Failure diagnostics:')
      await expect(readFile(failure.env.CAPTURE_OUTER_MARKER!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('reports verification success but preserves a later Kind cleanup failure', async () => {
    await withTestTempDirectory(async (temporaryDirectory) => {
      const run = runMain('main-success-cleanup-fail', { TMPDIR: temporaryDirectory })
      await expect(run).rejects.toMatchObject({ code: 8 })
      const failure = await run.catch((error: { stdout: string; stderr: string }) => error)
      expect(failure.stdout).toContain('OK-169 local Kubernetes deployment proof passed.')
      expect(failure.stderr).toContain('Failure diagnostics:')
      const directory = failure.stderr.match(/^Failure diagnostics: (.+)$/m)?.[1]
      expect(directory?.startsWith(`${temporaryDirectory}/`)).toBe(true)
      await cleanupFailureArtifact(failure)
    })
  })
})
