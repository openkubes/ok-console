// Message matching is restricted to this pg query boundary and pinned by tests to pg 8.23.0 and pg-pool 3.14.0.
const MESSAGES = new Map([
  ['Query read timeout', 'PG_QUERY_TIMEOUT'],
  ['Connection terminated due to connection timeout', 'PG_CONNECT_TIMEOUT'],
  ['Connection terminated unexpectedly', 'PG_CONNECTION_TERMINATED'],
  ['timeout exceeded when trying to connect', 'PG_POOL_TIMEOUT'],
])
const SQLSTATES = new Map([
  ['57014', 'PG_STATEMENT_TIMEOUT'], ['55P03', 'PG_LOCK_TIMEOUT'],
  ['57P01', 'PG_CONNECTION_TERMINATED'], ['25P03', 'PG_IDLE_TRANSACTION_TIMEOUT'],
])
export const classifyPgError = error => {
  const code = Object.getOwnPropertyDescriptor(error ?? {}, 'code')?.value
  const message = Object.getOwnPropertyDescriptor(error ?? {}, 'message')?.value
  const classified = SQLSTATES.get(code) ?? (code === undefined ? MESSAGES.get(message) : undefined)
  // Deliberately omit cause: diagnostics keep the deepest code.
  return classified ? Object.assign(new Error('PostgreSQL operation failed.'), { code: classified }) : error
}
export const pgQuery = async (pool, ...args) => {
  try { return await pool.query(...args) } catch (error) { throw classifyPgError(error) }
}

// Connection acquisition shares the pinned pg boundary, including code-less pg-pool timeouts.
export const pgConnect = (pool) => pgQuery({ query: () => pool.connect() })
