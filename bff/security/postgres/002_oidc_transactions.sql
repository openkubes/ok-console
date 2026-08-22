CREATE TABLE IF NOT EXISTS ok_console.oidc_transactions (
  transaction_digest text PRIMARY KEY CHECK (transaction_digest ~ '^[A-Za-z0-9_-]{43}$'),
  payload_envelope text NOT NULL CHECK (octet_length(payload_envelope) BETWEEN 1 AND 524288),
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 512),
  deployment_epoch text NOT NULL CHECK (length(deployment_epoch) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT oidc_transactions_expiry_order CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS oidc_transactions_expiry_idx
  ON ok_console.oidc_transactions (expires_at);

COMMENT ON TABLE ok_console.oidc_transactions IS
  'One-time encrypted OIDC flow state. Authorization codes and provider tokens are prohibited.';
