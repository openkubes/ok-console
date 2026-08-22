#!/usr/bin/env node

import { randomBytes, scrypt as nodeScrypt } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

const scrypt = promisify(nodeScrypt)
const context = process.env.OK_CONSOLE_KUBE_CONTEXT ?? 'ok-shared-admin@ok-shared'
const namespace = 'openkubes-console'
const managedBy = 'ok-170'
const kdf = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024 }

const kubectl = (args, options = {}) => spawnSync('kubectl', args, {
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
  ...options,
})

const checked = (result, label) => {
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`)
  return result.stdout.trim()
}

const readHidden = (prompt) => new Promise((resolve, reject) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    reject(new Error('Bootstrap password entry requires an interactive TTY.'))
    return
  }
  let value = ''
  const finish = (error) => {
    process.stdin.off('data', onData)
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write('\n')
    if (error) reject(error)
    else resolve(value)
  }
  const onData = (chunk) => {
    for (const character of chunk) {
      if (character === '\u0003') return finish(new Error('Password entry cancelled.'))
      if (character === '\r' || character === '\n') return finish()
      if (character === '\u007f') value = value.slice(0, -1)
      else if (character >= ' ') value += character
    }
  }
  process.stdout.write(prompt)
  process.stdin.setEncoding('utf8')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', onData)
})

const secret = (name, data) => ({
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: {
    name,
    namespace,
    labels: {
      'app.kubernetes.io/part-of': 'openkubes',
      'openkubes.io/managed-by': 'ok-172-bootstrap',
    },
  },
  type: 'Opaque',
  data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')])),
})

const main = async () => {
  if (process.env.OK_CONSOLE_APPLY_BOOTSTRAP !== 'true') {
    throw new Error('Refusing to provision credentials without OK_CONSOLE_APPLY_BOOTSTRAP=true.')
  }

  const actualContext = checked(kubectl(['config', 'current-context']), 'Reading the current Kubernetes context')
  if (actualContext !== context) throw new Error(`Current context '${actualContext}' is not '${context}'.`)

  const owner = checked(kubectl([
    '--context', context, 'get', 'namespace', namespace,
    '-o', 'jsonpath={.metadata.labels.openkubes\\.io/managed-by}',
  ]), 'Reading namespace ownership')
  if (owner !== managedBy) throw new Error(`Namespace '${namespace}' is not owned by ${managedBy}.`)

  for (const name of ['ok-console-session', 'ok-console-local-access']) {
    const existing = kubectl(['--context', context, '--namespace', namespace, 'get', 'secret', name, '--ignore-not-found'])
    if (existing.error) throw existing.error
    if (existing.status !== 0) throw new Error(`Checking Secret/${name} failed.`)
    if (existing.stdout.trim()) throw new Error(`Secret/${name} already exists; implicit credential rotation is prohibited.`)
  }

  let password = await readHidden('Bootstrap password for user arash: ')
  let confirmation = await readHidden('Confirm bootstrap password: ')
  if (password !== confirmation) throw new Error('The bootstrap passwords do not match.')
  confirmation = ''
  if (password.length < 16 || password.length > 256) {
    throw new Error('The bootstrap password must contain between 16 and 256 characters.')
  }

  const salt = randomBytes(16)
  const verifier = await scrypt(password, salt, 32, kdf)
  password = ''
  const envelopeKey = randomBytes(32).toString('base64')
  const pepper = randomBytes(32).toString('base64')
  const account = {
    version: 'v1',
    accounts: [{
      username: 'arash',
      enabled: true,
      salt: salt.toString('base64'),
      verifier: Buffer.from(verifier).toString('base64'),
      identityId: 'user-arash',
      displayName: 'Arash Kaffamanesh',
      environmentId: 'ok-shared',
      tenantIds: ['platform'],
      permissions: ['platform.read', 'clusters.read', 'evidence.read'],
    }],
  }

  const document = {
    apiVersion: 'v1',
    kind: 'List',
    items: [
      secret('ok-console-session', { 'keys.json': JSON.stringify({ 'session-key-v1': envelopeKey }) }),
      secret('ok-console-local-access', { 'accounts.json': JSON.stringify(account), pepper }),
    ],
  }
  const applied = kubectl([
    '--context', context, 'apply', '--server-side', '--field-manager=ok-172-bootstrap', '-f', '-',
  ], { input: JSON.stringify(document) })
  checked(applied, 'Provisioning the bootstrap Secret objects')

  console.log('Provisioned Secret/ok-console-session and Secret/ok-console-local-access without printing credential material.')
  console.log('The bootstrap password exists only in the operator session; store it in the approved credential manager now.')
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
