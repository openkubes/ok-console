-- Apply with the migration identity, never from a request handler.
CREATE SCHEMA IF NOT EXISTS ok_identity;
CREATE TABLE IF NOT EXISTS ok_identity.state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  initialized boolean NOT NULL DEFAULT false
);
INSERT INTO ok_identity.state VALUES (true, false) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ok_identity.accounts (
  id uuid PRIMARY KEY,
  username text UNIQUE NOT NULL CHECK (username ~ '^[a-z][a-z0-9._-]{2,31}$'),
  salt text NOT NULL,
  verifier text NOT NULL,
  hash_profile text NOT NULL CHECK (hash_profile = 'scrypt-v1'),
  administrator boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS ok_identity.login_throttle (LIKE ok_console.local_access_throttle INCLUDING ALL);
CREATE TABLE IF NOT EXISTS ok_identity.audit (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text NOT NULL,
  target_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('Initialized','Created','Disabled','Recovered','LoginGranted','LoginDenied')),
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Separate schema/table owners and bounded runtime grants are required by the profile.
REVOKE ALL ON SCHEMA ok_identity FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA ok_identity FROM PUBLIC;
ALTER TABLE ok_console.sessions DROP CONSTRAINT IF EXISTS sessions_authentication_method_check;
ALTER TABLE ok_console.sessions ADD CONSTRAINT sessions_authentication_method_check
  CHECK (authentication_method IN ('OIDC','Bootstrap','BreakGlass','Local'));
CREATE TABLE IF NOT EXISTS ok_console.authentication_audit (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  correlation_id text NOT NULL, authentication_method text NOT NULL,
  outcome text NOT NULL, cause text NOT NULL, principal_digest text,
  operational_reason text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE ok_console.authentication_audit DROP CONSTRAINT IF EXISTS authentication_audit_authentication_method_check;
ALTER TABLE ok_console.authentication_audit ADD CONSTRAINT authentication_audit_authentication_method_check
  CHECK (authentication_method IN ('OIDC','Bootstrap','BreakGlass','Local'));
