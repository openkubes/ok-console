CREATE TABLE IF NOT EXISTS ok_console.local_access_throttle (
  principal_digest text PRIMARY KEY CHECK (principal_digest ~ '^[A-Za-z0-9_-]{43}$'),
  failures integer NOT NULL CHECK (failures BETWEEN 0 AND 100000),
  window_started_at timestamptz NOT NULL,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS local_access_throttle_updated_idx
  ON ok_console.local_access_throttle (updated_at);

COMMENT ON TABLE ok_console.local_access_throttle IS
  'Digest-only cross-replica throttle state for exceptional local Console access.';
