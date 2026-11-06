// @vitest-environment node

import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const sourceScript = fileURLToPath(new URL('./verify-local-kind.sh', import.meta.url))
const temporaryRoots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ok-local-verifier-test-'))
  temporaryRoots.push(root)
  const repository = path.join(root, 'repository')
  const scriptDir = path.join(repository, 'deploy', 'kubernetes')
  const fakeBin = path.join(root, 'bin')
  await mkdir(path.join(scriptDir, 'overlays', 'local-kind'), { recursive: true })
  await mkdir(fakeBin)
  await writeFile(path.join(scriptDir, 'verify-local-kind.sh'), await readFile(sourceScript))
  await writeFile(path.join(scriptDir, 'capture-local-kind-failure.sh'), '#!/usr/bin/env bash\nexit 0\n')
  await chmod(path.join(scriptDir, 'capture-local-kind-failure.sh'), 0o755)

  const writeMock = async (name: string, body: string) => {
    const target = path.join(fakeBin, name)
    await writeFile(target, `#!/usr/bin/env bash\n${body}\n`)
    await chmod(target, 0o755)
  }
  await writeMock('git', `
if [[ "\${MOCK_GIT_FAIL:-}" == true ]]; then echo 'Bearer mock-git-secret' >&2; exit 19; fi
case "$*" in
  *'rev-parse --short=12 HEAD') printf '0123456789ab\\n' ;;
  *'rev-parse HEAD') printf '0123456789abcdef0123456789abcdef01234567\\n' ;;
  *) exit 0 ;;
esac`)
  await writeMock('kind', `
printf '%s\\n' "$*" >> "$MOCK_KIND_LOG"
case "$*" in
  version) printf 'kind v0.33.0 go1.27.0 darwin/arm64\\n' ;;
  'get clusters')
    if [[ "\${MOCK_KIND_LIST_FAIL:-}" == true ]]; then echo 'Authorization: Bearer mock-list-secret' >&2; exit 23; fi
    exit 0 ;;
  'create cluster'*)
    if [[ "\${MOCK_KIND_CREATE_FAIL:-}" == true ]]; then echo 'client-key: mock-create-secret' >&2; exit 24; fi
    exit 0 ;;
  'delete cluster'*) exit 0 ;;
  *) exit 0 ;;
esac`)
  await writeMock('docker', `
if [[ "$*" == 'image inspect '* ]]; then
  if [[ "\${MOCK_IMAGE_FAIL:-}" == true ]]; then echo 'password=mock-image-secret' >&2; exit 25; fi
  printf '0123456789abcdef0123456789abcdef01234567\\n'; exit 0
fi
if [[ "$*" == 'pull '* && "\${MOCK_IMAGE_FAIL:-}" == true ]]; then echo 'token=mock-pull-secret' >&2; exit 26; fi
exit 0`)
  for (const name of ['kubectl', 'curl']) await writeMock(name, 'exit 0')
  await writeMock('mktemp', `
if [[ "\${MOCK_MKTEMP_FAIL:-}" == true ]]; then echo 'secret=mock-temp-secret' >&2; exit 27; fi
exec "${process.env.PATH?.split(path.delimiter).includes('/usr/bin') ? '/usr/bin/mktemp' : '/usr/bin/mktemp'}" "$@"`)

  const kindLog = path.join(root, 'kind.log')
  const script = path.join(scriptDir, 'verify-local-kind.sh')
  const run = (clusterName: string, extra: Record<string, string> = {}) => {
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
        TMPDIR: root,
        MOCK_KIND_LOG: kindLog,
        OK_CONSOLE_KIND_CLUSTER: clusterName,
        OK_CONSOLE_KEEP_CLUSTER: 'true',
        OK_CONSOLE_MIN_KIND_VERSION: '0.33.0',
        OK_CONSOLE_IMAGE: `ghcr.io/openkubes/ok-console@sha256:${'a'.repeat(64)}`,
        ...extra,
      },
    })
    return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, kindLog }
  }
  return { run, kindLog }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('local Kind verifier bounded name and safe diagnostics contract', () => {
  it('accepts 50 characters and rejects 51 before Kind inventory or create', async () => {
    const f = await fixture()
    const tooLong = f.run('a'.repeat(51))
    expect(tooLong.status).not.toBe(0)
    expect(tooLong.output).toContain('stage=preflight code=KIND_NAME_TOO_LONG')
    expect(tooLong.output).not.toContain('mock-')
    expect(await readFile(f.kindLog).then(() => true).catch(() => false)).toBe(false)

    await writeFile(f.kindLog, '')
    const accepted = f.run('a'.repeat(50), { MOCK_KIND_CREATE_FAIL: 'true' })
    expect(accepted.status).not.toBe(0)
    expect(accepted.output).toContain('stage=kind_create code=KIND_CONFIG_OR_CREATE_FAILED')
    expect(await readFile(f.kindLog, 'utf8')).toContain('create cluster')
  }, 15000)

  it('rejects Kind-list failure before create and suppresses command output', async () => {
    const f = await fixture()
    const result = f.run('ok-local-safe', { MOCK_KIND_LIST_FAIL: 'true' })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('stage=kind_inventory code=KIND_LIST_FAILED')
    expect(result.output).not.toContain('mock-list-secret')
    expect(await readFile(f.kindLog, 'utf8')).toContain('get clusters')
    expect(await readFile(f.kindLog, 'utf8')).not.toContain('create cluster')
  })

  it('classifies Kind-create failure without exposing its stderr', async () => {
    const f = await fixture()
    const result = f.run('ok-local-safe', { MOCK_KIND_CREATE_FAIL: 'true' })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('stage=kind_create code=KIND_CONFIG_OR_CREATE_FAILED')
    expect(result.output).not.toContain('mock-create-secret')
  })

  it('classifies image-stage failure and keeps raw command diagnostics out of output', async () => {
    const f = await fixture()
    const result = f.run('ok-local-safe', { MOCK_IMAGE_FAIL: 'true' })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('stage=image_deploy code=IMAGE_OR_DEPLOY_FAILED')
    expect(result.output).not.toContain('mock-image-secret')
    expect(result.output).not.toContain('mock-pull-secret')
  })

  it('classifies temp-file preparation errors and suppresses raw stderr', async () => {
    const f = await fixture()
    const result = f.run('ok-local-safe', { MOCK_MKTEMP_FAIL: 'true' })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('stage=temp_file code=TEMP_FILE_PREPARATION_FAILED')
    expect(result.output).not.toContain('mock-temp-secret')
    expect(result.kindLog).toBeTruthy()
    if (await readFile(result.kindLog).then(() => true).catch(() => false)) {
      expect(await readFile(result.kindLog, 'utf8')).toBe('version\n')
    }
  })

  it('maps an early shell command failure to UNKNOWN without forwarding its stderr', async () => {
    const f = await fixture()
    const result = f.run('ok-local-safe', { MOCK_GIT_FAIL: 'true' })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('stage=unknown code=UNKNOWN')
    expect(result.output).not.toContain('mock-git-secret')
    expect(result.kindLog).toBeTruthy()
    if (await readFile(result.kindLog).then(() => true).catch(() => false)) {
      expect(await readFile(result.kindLog, 'utf8')).toBe('')
    }
  })
})
