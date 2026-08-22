CREATE SCHEMA IF NOT EXISTS ok_console;

CREATE TABLE IF NOT EXISTS ok_console.sessions (
  session_digest text PRIMARY KEY CHECK (session_digest ~ '^[A-Za-z0-9_-]{43}$'),
  session_family_digest text NOT NULL CHECK (session_family_digest ~ '^[A-Za-z0-9_-]{43}$'),
  context_envelope text NOT NULL CHECK (octet_length(context_envelope) BETWEEN 1 AND 524288),
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 512),
  csrf_digest text NOT NULL CHECK (csrf_digest ~ '^[A-Za-z0-9_-]{43}$'),
  authentication_method text NOT NULL CHECK (authentication_method IN ('OIDC', 'BreakGlass', 'Bootstrap')),
  authorization_revision text NOT NULL CHECK (length(authorization_revision) BETWEEN 1 AND 512),
  deployment_epoch text NOT NULL CHECK (length(deployment_epoch) BETWEEN 1 AND 512),
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  idle_lifetime_ms bigint NOT NULL CHECK (idle_lifetime_ms > 0),
  issued_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 512),
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (issued_at < absolute_expires_at),
  CHECK ((revoked_at IS NULL AND revoke_reason IS NULL) OR revoked_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS sessions_idle_expiry_idx
  ON ok_console.sessions (idle_expires_at);

CREATE INDEX IF NOT EXISTS sessions_absolute_expiry_idx
  ON ok_console.sessions (absolute_expires_at);

CREATE INDEX IF NOT EXISTS sessions_revoked_at_idx
  ON ok_console.sessions (revoked_at)
  WHERE revoked_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_family_idx
  ON ok_console.sessions (session_family_digest);

COMMENT ON TABLE ok_console.sessions IS
  'Opaque OpenKubes Console sessions. Raw cookies, raw CSRF values and provider tokens are prohibited.';
