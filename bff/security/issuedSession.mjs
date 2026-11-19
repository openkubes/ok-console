// A session that was issued and audited Granted must never be answered as a credential
// rejection. When the response that carries it cannot be written, withdraw the session
// (revoke it, then audit the revocation) and answer "unavailable" — or drop the connection
// when the status line has already gone out. A failed revocation is logged and leaves the
// Granted record as the last audit fact; it is never reported as a rejected credential.
export const RESPONSE_FAILED = 'RESPONSE_FAILED'
export const WITHDRAWN_REASON = 'Issued session withdrawn after a response failure'

export const deliverIssuedSession = async ({ response, write, revoke, audit, unavailable, log }) => {
  try {
    write()
    return true
  } catch (writeError) {
    log('RESPONSE_WRITE', writeError)
    let revoked = false, revokeError = null
    try { revoked = await revoke() === true } catch (error) { revokeError = error }
    if (!revoked) log('RESPONSE_WRITE_REVOKE', revokeError)
    else {
      try { await audit() } catch (error) { log('RESPONSE_WRITE_AUDIT', error) }
    }
    if (response.headersSent) response.destroy?.()
    else {
      try { unavailable() } catch (error) {
        log('RESPONSE_WRITE', error)
        response.destroy?.()
      }
    }
    return false
  }
}
