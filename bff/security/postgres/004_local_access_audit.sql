CREATE TABLE IF NOT EXISTS ok_console.local_access_audit (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  principal_digest text NOT NULL CHECK (principal_digest ~ '^[A-Za-z0-9_-]{43}$'),
  authentication_method text NOT NULL CHECK (authentication_method IN ('Bootstrap', 'BreakGlass')),
  outcome text NOT NULL CHECK (outcome IN ('Granted', 'Denied')),
  cause text NOT NULL CHECK (length(cause) BETWEEN 1 AND 64),
  operational_reason text NOT NULL CHECK (length(operational_reason) BETWEEN 12 AND 512),
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 512),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS local_access_audit_occurred_idx
  ON ok_console.local_access_audit (occurred_at);

COMMENT ON TABLE ok_console.local_access_audit IS
  'Append-only exceptional-access authentication Evidence without credentials or raw usernames.';
