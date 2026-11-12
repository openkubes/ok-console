import { X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Healthy fixtures must tolerate host wall-clock corrections between issuance
// and their first handshake. Deliberate expired/future cases override these.
export const TEST_CERTIFICATE_START = '20200101000000Z'
export const TEST_CERTIFICATE_END = '20500101000000Z'

export const issueTestCertificate = ({ root, name, issuer = 'ca', selfSigned = false,
  csr = name + '.csr', privateKey = issuer + '.key', extensions,
  startDate = TEST_CERTIFICATE_START, endDate = TEST_CERTIFICATE_END,
  opensslBinary = 'openssl' }) => {
  const prefix = name + '-sign'
  if (existsSync(join(root, name + '.crt'))) throw new Error('Fixture certificate already exists.')
  writeFileSync(join(root, prefix + '.index'), '', { flag: 'wx' })
  writeFileSync(join(root, prefix + '.serial'), '01\n', { flag: 'wx' })
  writeFileSync(join(root, prefix + '.ext'), extensions, { flag: 'wx' })
  writeFileSync(join(root, prefix + '.cnf'), `[ca]
default_ca=local
[local]
database=${prefix}.index
serial=${prefix}.serial
new_certs_dir=.
certificate=${issuer}.crt
private_key=${privateKey}
default_md=sha256
policy=policy
[policy]
commonName=supplied
`, { flag: 'wx' })
  execFileSync(opensslBinary, ['ca', '-batch', '-notext', '-rand_serial', '-config', prefix + '.cnf',
    ...(selfSigned ? ['-selfsign'] : []), '-in', csr, '-out', name + '.crt',
    '-startdate', startDate, '-enddate', endDate, '-extfile', prefix + '.ext'], { cwd: root, stdio: 'ignore' })
  if (startDate === TEST_CERTIFICATE_START && endDate === TEST_CERTIFICATE_END) {
    const cert = new X509Certificate(readFileSync(join(root, name + '.crt')))
    if (!(Date.parse(cert.validFrom) < Date.now() - 3600000 && Date.parse(cert.validTo) > Date.now() + 3600000)) throw new Error('Healthy fixture lacks the required validity margin.')
  }
}
