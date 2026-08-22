import { readFileSync, statSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

const MAX_TLS_FILE_BYTES = 64 * 1024

const readTlsFile = (path, name) => {
  if (!path) throw new Error(`${name} is required for the observed-state mTLS profile.`)
  let metadata
  try {
    metadata = statSync(path)
  } catch {
    throw new Error(`${name} must reference a mounted regular file.`)
  }
  if (!metadata.isFile()) throw new Error(`${name} must reference a mounted regular file.`)
  if (metadata.size < 1 || metadata.size > MAX_TLS_FILE_BYTES) {
    throw new Error(`${name} must contain between 1 and ${MAX_TLS_FILE_BYTES} bytes.`)
  }
  return readFileSync(path)
}

export const createObservedStateMtlsFetch = ({ ca, certificate, privateKey }) => {
  if (!ca?.length || !certificate?.length || !privateKey?.length) {
    throw new Error('Observed-state mTLS requires CA, client certificate and private key material.')
  }

  return (input, options = {}) => new Promise((resolve, reject) => {
    const url = input instanceof URL ? input : new URL(input)
    if (url.protocol !== 'https:') {
      reject(new Error('Observed-state mTLS transport requires HTTPS.'))
      return
    }
    const request = httpsRequest(url, {
      method: options.method ?? 'GET',
      headers: Object.fromEntries(new Headers(options.headers).entries()),
      signal: options.signal,
      ca,
      cert: certificate,
      key: privateKey,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      agent: false,
    }, (response) => {
      resolve(new Response(Readable.toWeb(response), {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: response.headers,
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

export const createObservedStateMtlsFetchFromFiles = ({ caFile, certificateFile, privateKeyFile }) =>
  createObservedStateMtlsFetch({
    ca: readTlsFile(caFile, 'OK_CONSOLE_OBSERVED_STATE_CA_FILE'),
    certificate: readTlsFile(certificateFile, 'OK_CONSOLE_OBSERVED_STATE_CLIENT_CERT_FILE'),
    privateKey: readTlsFile(privateKeyFile, 'OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE'),
  })
