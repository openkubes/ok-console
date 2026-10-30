// Message matching is restricted to this pg query boundary and pinned by tests to pg 8.23.0 and pg-pool 3.14.0.
const MESSAGES = new Map([
  ['Query read timeout', 'PG_QUERY_TIMEOUT'],
  ['Connection terminated due to connection timeout', 'PG_CONNECT_TIMEOUT'],
  ['Connection terminated unexpectedly', 'PG_CONNECTION_TERMINATED'],
  ['timeout exceeded when trying to connect', 'PG_POOL_TIMEOUT'],
])
export const pgQuery = async (pool, ...args) => {
  try { return await pool.query(...args) } catch (error) {
    const code = Object.getOwnPropertyDescriptor(error ?? {}, 'code')?.value
    const message = Object.getOwnPropertyDescriptor(error ?? {}, 'message')?.value
    if (code === '57014') {
      throw Object.assign(new Error('PostgreSQL statement timed out.'), { code: 'PG_STATEMENT_TIMEOUT' })
    }
    if (code === undefined && MESSAGES.has(message)) {
      // Deliberately omit cause: startErrorCode keeps the deepest code.
      throw Object.assign(new Error('PostgreSQL operation failed.'), { code: MESSAGES.get(message) })
    }
    throw error
  }
}

// Connection acquisition shares the pinned pg boundary, including code-less pg-pool timeouts.
export const pgConnect = (pool) => pgQuery({ query: () => pool.connect() })
