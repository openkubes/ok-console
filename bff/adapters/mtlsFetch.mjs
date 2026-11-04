import { createAttempt, attachAttempt } from '../diagnostics.mjs'
import { readFileSync, statSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

import { sourceHttpError } from './sourceFailure.mjs'

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
    const attempt = options.sourceAttempt ?? createAttempt()
    attempt.phase(url.hostname.match(/^[0-9.]+$/) || url.hostname.includes(':') ? 'CONNECT' : 'DNS')
    let responseStream
    const request = httpsRequest(url, {
      method: options.method ?? 'GET',
      headers: Object.fromEntries(new Headers(options.headers).entries()),
      signal: options.signal,
      ca,
      cert: certificate,
      key: privateKey,
      minVersion: 'TLSv1.3',
      rejectUnauthorized: true,
      agent: false,
    }, (response) => {
      if (!options.sourceAttempt) response.once('close', () => attempt.finish())
      attempt.complete('headers', 'HEADERS_RECEIVED', 'BODY')
      // Fetch forbids bodies for these statuses, even an empty Node stream.
      const bodyless = [204, 205, 304].includes(response.statusCode)
      if (bodyless) response.resume()
      if (!bodyless) responseStream = response
      try { resolve(new Response(bodyless ? null : Readable.toWeb(response), {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: response.headers,
      })) } catch (error) {
        response.destroy()
        // A parsed non-success status remains authoritative if Fetch rejects
        // its status range, reason phrase or headers.
        attempt.phase('AWAIT_HEADERS')
        reject(response.statusCode < 200 || response.statusCode >= 300 ? sourceHttpError(response.statusCode) : error)
      }
    })
    request.on('socket', (socket) => {
      socket.once('lookup', (error) => { if (!error) attempt.complete('dns', 'DNS_RESOLVED', 'CONNECT') })
      socket.once('connect', () => attempt.complete('connect', 'TCP_CONNECTED', 'TLS_HANDSHAKE'))
      socket.once('secureConnect', () => attempt.complete('tls', 'TLS_ESTABLISHED', 'AWAIT_HEADERS'))
    })
    request.once('upgrade', (response, socket) => {
      socket.destroy()
      reject(sourceHttpError(response.statusCode))
    })
    request.once('error', (error) => {
      // After headers the fetch promise has resolved; preserve the own code
      // on its body instead of Node replacing it with an aborted reset.
      responseStream?.destroy(error)
      reject(attachAttempt(error, attempt))
    })
    request.end()
  })
}

export const createObservedStateMtlsFetchFromFiles = ({ caFile, certificateFile, privateKeyFile }) =>
  createObservedStateMtlsFetch({
    ca: readTlsFile(caFile, 'OK_CONSOLE_OBSERVED_STATE_CA_FILE'),
    certificate: readTlsFile(certificateFile, 'OK_CONSOLE_OBSERVED_STATE_CLIENT_CERT_FILE'),
    privateKey: readTlsFile(privateKeyFile, 'OK_CONSOLE_OBSERVED_STATE_CLIENT_KEY_FILE'),
  })
