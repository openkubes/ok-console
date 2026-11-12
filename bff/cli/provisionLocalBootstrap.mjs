import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { protectedPrompt } from './localIdentity.mjs'

// Installation authority writes only mounted verifier/key material, never database rows.
const run = async () => {
  const [directory, username] = process.argv.slice(2)
  if (!directory || !isAbsolute(directory) || !/^[a-z][a-z0-9._-]{2,31}$/.test(username ?? '') || process.argv.length !== 4) throw new Error()
  const environmentId = process.env.OK_CONSOLE_ENVIRONMENT_ID
  const tenantId = process.env.OK_CONSOLE_TENANT_ID
  if (!environmentId || !tenantId) throw new Error()
  let password = await protectedPrompt('Named Bootstrap password (15+ characters)')
  let confirmation = await protectedPrompt('Confirm Bootstrap password')
  if (password !== confirmation || password.length < 15 || Buffer.byteLength(password) > 256) throw new Error()
  confirmation = ''
  const salt = randomBytes(16)
  // Preserve the existing exceptional-access verifier profile; ordinary users use scrypt-v1.
  const verifier = scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:67108864}).toString('base64')
  password = ''
  await mkdir(directory,{mode:0o700}) // Exclusive: no implicit rotation or overwrite.
  const put = (name,content) => writeFile(`${directory}/${name}`,content,{mode:0o600,flag:'wx'})
  await put('bootstrap.json',JSON.stringify({version:'v1',accounts:[{
    username,enabled:true,salt:salt.toString('base64'),verifier,identityId:randomUUID(),displayName:username,environmentId,tenantIds:[tenantId],
    permissions:['local.users.initialize','local.users.recover'],
  }]}))
  await put('pepper',randomBytes(32).toString('base64'))
  await put('keys.json',JSON.stringify({'local-key-1':randomBytes(32).toString('base64')}))
  process.stdout.write('Local verifier and key files provisioned. Protect and escrow recovery material separately.\n')
}
run().catch(()=>{process.stderr.write('Provisioning failed; inspect protected files before retrying. No credentials are printed.\n');process.exitCode=1})
