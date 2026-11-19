// A session that was issued and audited Granted must never be answered as a credential
// rejection. When the response that carries it cannot be written, withdraw the session
// (revoke it, then audit the revocation) and answer "unavailable" — or drop the connection
// when the status line has already gone out. A failed revocation is logged and leaves the
// Granted record as the last audit fact; it is never reported as a rejected credential.
export const RESPONSE_FAILED = 'RESPONSE_FAILED'
export const WITHDRAWN_REASON = 'Issued session withdrawn after a response failure'

// Resolves true once the response was handed to the transport (finish), false when the
// connection closed first. Plain test doubles without stream state count as delivered.
const delivered = (response) => new Promise((resolve) => {
  if (typeof response.once !== 'function' || !('writableFinished' in response) || response.writableFinished) return resolve(true)
  if (response.destroyed) return resolve(false)
  const done = (value) => {
    response.off('finish', onFinish)
    response.off('close', onClose)
    resolve(value)
  }
  const onFinish = () => done(true)
  const onClose = () => done(response.writableFinished === true)
  response.once('finish', onFinish)
  response.once('close', onClose)
})

export const deliverIssuedSession = async ({ response, write, revoke, audit, unavailable, log }) => {
  let failure = null
  // A client that disconnected during verification never receives the cookie; writing to a
  // destroyed response does not throw, so check first and again after the write settles.
  if (response.destroyed) failure = new Error('Response closed before the session was delivered.')
  else {
    try { write() } catch (error) { failure = error }
    if (!failure && !await delivered(response)) failure = new Error('Response closed before the session was delivered.')
  }
  if (!failure) return true
  log('RESPONSE_WRITE', failure)
  let revoked = false, revokeError = null
  try { revoked = await revoke() === true } catch (error) { revokeError = error }
  if (!revoked) log('RESPONSE_WRITE_REVOKE', revokeError)
  else {
    try { await audit() } catch (error) { log('RESPONSE_WRITE_AUDIT', error) }
  }
  if (response.headersSent || response.destroyed) response.destroy?.()
  else {
    try { unavailable() } catch (error) {
      log('RESPONSE_WRITE', error)
      response.destroy?.()
    }
  }
  return false
}
