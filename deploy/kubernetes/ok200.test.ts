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
const verifier = fileURLToPath(new URL('./verify-local-kind.sh', import.meta.url))
let fixtureDirectory = ''

const kubectlStub = `#!/usr/bin/env bash
set -Eeuo pipefail
arguments=" $* "
if [[ "\${arguments}" == *" get deployment ok-console "* ]]; then
  printf 'deployment-uid|7\\n'
elif [[ "\${arguments}" == *" get replicasets "* ]]; then
  case "\${KUBECTL_SCENARIO}" in
    no-current-rs) printf 'old-rs|old-uid|6|deployment-uid\\nunrelated-rs|unrelated-uid|7|other-deployment-uid\\n' ;;
    multiple-current-rs) printf 'current-rs|current-uid|7|deployment-uid\\nduplicate-rs|duplicate-uid|7|deployment-uid\\n' ;;
    *) printf 'old-rs|old-uid|6|deployment-uid\\nunrelated-rs|unrelated-uid|7|other-deployment-uid\\ncurrent-rs|current-uid|7|deployment-uid\\n' ;;
  esac
elif [[ "\${arguments}" == *" get pods "* ]]; then
  case "\${KUBECTL_SCENARIO}" in
    valid) printf 'current-pod|current-uid|True||Running\\n' ;;
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
    *) printf 'unknown scenario: %s\\n' "\${KUBECTL_SCENARIO}" >&2; exit 2 ;;
  esac
elif [[ "\${arguments}" == *" port-forward "* ]]; then
  exec node "\${KUBECTL_BINDER}" "$@"
else
  printf 'unexpected kubectl invocation: %s\\n' "$*" >&2
  exit 2
fi
`

const binderStub = `const net = require('node:net')
const args = process.argv.slice(2)
const addressIndex = args.indexOf('--address')
if (addressIndex < 0 || args[addressIndex + 1] !== '127.0.0.1') {
  console.error('missing exact IPv4 --address')
  process.exit(2)
}
if (process.env.KUBECTL_SCENARIO === 'process-exit') {
  console.error('unable to upgrade connection: pod not found')
  process.exit(42)
}
const mapping = args.find((argument) => /^\\d+:8787$/.test(argument))
const port = Number(mapping?.split(':')[0])
const server = net.createServer()
server.once('error', (error) => {
  console.error('Unable to listen on port ' + port + ': ' + error.message)
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => {
  if (process.env.KUBECTL_SCENARIO === 'ready') {
    console.log('Forwarding from 127.0.0.1:' + port + ' -> 8787')
  } else if (process.env.KUBECTL_SCENARIO === 'wrong-port') {
    console.log('Forwarding from 127.0.0.1:' + (port + 1) + ' -> 8787')
  } else if (process.env.KUBECTL_SCENARIO === 'wrong-port-prefix') {
    console.log('Forwarding from 127.0.0.1:' + port + '0 -> 8787')
  } else if (process.env.KUBECTL_SCENARIO === 'wrong-address') {
    console.log('Forwarding from [::1]:' + port + ' -> 8787')
  }
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
setTimeout(() => process.exit(3), 5000)
`

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'ok-console-ok200-'))
  await Promise.all([
    writeFile(join(fixtureDirectory, 'kubectl'), kubectlStub),
    writeFile(join(fixtureDirectory, 'binder.cjs'), binderStub),
    writeFile(join(fixtureDirectory, 'curl'), '#!/usr/bin/env bash\ntouch "${CURL_CALLED}"\n'),
  ])
  await Promise.all([
    chmod(join(fixtureDirectory, 'kubectl'), 0o755),
    chmod(join(fixtureDirectory, 'curl'), 0o755),
  ])
})

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true })
})

let execution = 0
const environment = (scenario: string) => ({
  ...process.env,
  PATH: `${fixtureDirectory}:${process.env.PATH}`,
  KUBECTL_SCENARIO: scenario,
  KUBECTL_BINDER: join(fixtureDirectory, 'binder.cjs'),
  KUBECTL_STATE: join(fixtureDirectory, 'state-' + scenario + '-' + execution++),
})

const selectPod = (scenario: string) => exec(
  'bash',
  ['-c', 'source "$1"; cluster_name=test; select_current_pod 3 0.01', '_', verifier],
  { env: environment(scenario), timeout: 6000, killSignal: 'SIGKILL' },
)

const unusedPort = async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port.')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

const waitForForward = async (scenario: string, port: number, timeoutSeconds = 2) => {
  const log = join(fixtureDirectory, `port-forward-${scenario}-${port}.log`)
  const curlCalled = join(fixtureDirectory, `curl-called-${scenario}-${port}`)
  const command = [
    'source "$1"',
    'cluster_name=test',
    'pod_name=current-pod',
    'local_port="$2"',
    'port_forward_log="$3"',
    'set +e',
    'start_and_wait_for_port_forward "$4" 0.01',
    'status=$?',
    'if [[ -n "${port_forward_pid}" ]]; then kill "${port_forward_pid}" 2>/dev/null || true; wait "${port_forward_pid}" 2>/dev/null || true; fi',
    'exit "${status}"',
  ].join('; ')
  await writeFile(log, '')
  try {
    const result = await exec('bash', ['-c', command, '_', verifier, String(port), log, String(timeoutSeconds)], {
      env: { ...environment(scenario), CURL_CALLED: curlCalled },
      timeout: 6000,
      killSignal: 'SIGKILL',
    })
    return { ...result, curlCalled, log }
  } catch (error) {
    throw Object.assign(error as object, { curlCalled, log })
  }
}

describe('OK-200 current ReplicaSet Pod selection', () => {
  it('accepts exactly one Ready, non-terminating current Pod', async () => {
    const result = await selectPod('valid')
    expect(result.stdout).toContain('Selected Pod current-pod of ReplicaSet current-rs')
  })

  it('accepts after an old ReplicaSet Pod disappears within the deadline', async () => {
    const result = await selectPod('old-transition')
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
  it('wires selection and readiness before the first HTTP probe in the main flow', async () => {
    const source = await readFile(verifier, 'utf8')
    expect(source).toContain('timeout_seconds="${1:-120}"')
    expect(source).toContain('timeout_seconds="${1:-30}"')
    const main = source.slice(source.indexOf('main() {'), source.indexOf('\n}\n\nif [[ "${BASH_SOURCE[0]}"'))
    expect(main.indexOf('select_current_pod\n')).toBeGreaterThan(-1)
    expect(main.indexOf('start_and_wait_for_port_forward\n')).toBeGreaterThan(main.indexOf('select_current_pod\n'))
    expect(main.indexOf('curl --fail')).toBeGreaterThan(main.indexOf('start_and_wait_for_port_forward\n'))
  })

  it('accepts only kubectl readiness for the exact IPv4 port without probing curl', async () => {
    const result = await waitForForward('ready', await unusedPort())
    await expect(readFile(result.curlCalled, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['missing-line', 'Timed out waiting for kubectl port-forward to report'],
    ['wrong-port', 'reported an unexpected forwarding endpoint'],
    ['wrong-port-prefix', 'reported an unexpected forwarding endpoint'],
    ['wrong-address', 'reported an unexpected forwarding endpoint'],
  ])('rejects %s with its cause', async (scenario, cause) => {
    const promise = waitForForward(scenario, await unusedPort(), scenario === 'missing-line' ? 1 : 2)
    await expect(promise).rejects.toMatchObject({ stderr: expect.stringContaining(cause) })
  }, 5000)

  it('reports the captured kubectl diagnostic when the process exits', async () => {
    const promise = waitForForward('process-exit', await unusedPort(), 2)
    await expect(promise).rejects.toMatchObject({
      stderr: expect.stringMatching(/exited before reporting readiness[\s\S]*unable to upgrade connection: pod not found/),
    })
  })

  it('rejects a pre-existing IPv4 listener and never treats it as tunnel readiness', async () => {
    const listener = createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Could not bind the occupied test port.')
    try {
      const promise = waitForForward('ready', address.port)
      await expect(promise).rejects.toMatchObject({
        stderr: expect.stringMatching(/exited before reporting readiness[\s\S]*EADDRINUSE/),
      })
      await expect(readFile(join(fixtureDirectory, `curl-called-ready-${address.port}`), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
    }
  }, 5000)
})
