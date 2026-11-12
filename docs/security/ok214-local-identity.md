# OK-214 CLI-first local identity

Non-production `ok-local` only. This implements the scoped ADR-037 amendment accepted
at openkubes/openkubes commit `5af40a5`; ADR-038 remains unchanged. No Kubernetes grants,
Projects, public registration, deletion, general role management or real user-management
UI. Developer Workspaces and the identity preview retain their existing boundaries.

## Supported deployment

This first profile is a **host process**, not a Kubernetes overlay. The existing BFF
serves both API and built frontend over native HTTPS on numeric loopback. No separate
proxy, published container port, Service, Ingress/Gateway, host networking or operator
is introduced. Pod-based operation is deferred. The runtime rejects a Kubernetes
service environment, wildcard/hostname binds, public/non-HTTPS origins, mismatched
origin/listener ports, missing profile/opt-in, non-development Node runtime, disabled
sessions, prototype authorization and failure injection. Disposable acknowledgements
cannot bypass these checks. No forwarding headers establish trust.

The host administrator can deliberately republish a loopback service; that is outside
the supported profile, not something a profile label can detect. Do not republish it.
Browser and CLI use verified HTTPS. The TLS key is read from a bounded absolute file;
use a private directory and a certificate with an IP SAN for the configured address.
Trust the operator's local CA in the browser; give the CLI that CA explicitly. No
insecure-TLS CLI switch exists. A production frontend build does not change the required
`NODE_ENV=development` backend profile.

## Installation authority and storage

Use a dedicated disposable/local PostgreSQL database. Apply numbered migrations
`bff/security/postgres/001` through `005` as the migration identity, not the application
or CLI. Migration 005 supplies the authentication-audit table missing from the earlier
standalone SQL directory (the existing shared deployment has its own audit migration).
It adds `Local` to closed database method constraints without changing existing methods.

Give `ok_identity` schema/tables a separate NOLOGIN owner from `ok_console` session
schema/tables. The BFF login role must not own either schema, have DDL authority, be a
superuser or have role/database-creation privileges. Grant it only:

- schema USAGE on `ok_console` and `ok_identity`;
- SELECT/INSERT/UPDATE/DELETE on sessions, OIDC transactions and the two throttle tables;
- SELECT/INSERT/UPDATE on identity accounts and SELECT/UPDATE on identity state;
- INSERT only on the three audit tables and USAGE on their identity sequences.

Migration, audit retention and recovery-of-database roles remain separate. Never give
these database credentials to the account-management CLI. Verify grants before use.
Preserve verified database TLS; the pre-existing explicit insecure-loopback database
exception is available only for a disposable local database. Never use it remotely.
Protect identity backups as credential material. Keep envelope keys outside database
backups. Restore/clone requires a new session epoch and envelope key before reopening;
account initialization state must not be reset. No HA/failover durability claim is made.

## Attended setup and commands

1. Start with `.env.ok-local.example` copied to a private location, replacing all absolute
   paths. Provision PostgreSQL connection material through protected files. Obtain a
   local TLS certificate/key and CA; keep private keys readable only by their owner.
2. Set the non-secret `OK_CONSOLE_ENVIRONMENT_ID` and `OK_CONSOLE_TENANT_ID` values for the
   intended local installation. Provision a **named** Bootstrap verifier and fresh keys:

   ```sh
   node bff/cli/provisionLocalBootstrap.mjs /absolute/private/identity boot-operator
   ```

   This command requires a TTY, prompts twice without echo, creates a new mode-0700
   directory and mode-0600 files, refuses overwrite, and never touches PostgreSQL or
   prints credentials. `boot-operator` is illustrative, not a built-in account. Its
   permissions are only `local.users.initialize` and `local.users.recover`; neither
   grants Kubernetes authority. Escrow this recovery verifier and its password separately.
3. Build and start the host process using the private environment file:

   ```sh
   VITE_CONSOLE_DATA_MODE=bff VITE_CONSOLE_AUTH_MODE=local pnpm build
   node --env-file=/absolute/private/ok-local.env bff/server.mjs
   ```

   Node's env file does not override existing process variables; conflicting inherited
   configuration must be removed. Startup must fail rather than bypass a restriction.
   The initial profile has exceptional mode `bootstrap`, with OIDC disabled as required
   by its existing guard.
4. In a separate attended terminal, load only the public origin and CA-file path into
   `OK_CONSOLE_ORIGIN` and `OK_CONSOLE_LOCAL_TLS_CA_FILE`. The CLI needs no server secrets:

   ```sh
   node bff/cli/localIdentity.mjs initialize named-admin --admin boot-operator
   node bff/cli/localIdentity.mjs create alice --admin named-admin --console-reader
   node bff/cli/localIdentity.mjs list --admin named-admin
   node bff/cli/localIdentity.mjs disable USER_UUID_FROM_LIST --admin named-admin
   ```

   Each command authenticates its named actor through the BFF, retains cookies/CSRF only
   in memory and logs out on exit. Passwords are prompted without echo; no password
   flags, environment variables, files or ordinary output are accepted for CLI input.
   The account cap is 1000, including the initial administrator.
   Creation requires explicit `--console-reader`: this grants only existing Console read
   projections for the configured environment/tenant. Login never invents membership,
   and this is not Kubernetes authorization. There is no promote/demote/delete command.
5. Initialization is a single audited transaction with a durable completion marker.
   Disabling all accounts does not reopen it. The ordinary-profile Bootstrap login gate
   closes after initialization. Set `OK_CONSOLE_LOCAL_ACCESS_MODE=disabled` and restart
   as cleanup; ordinary login continues. Existing exceptional profiles outside this
   opt-in remain unchanged.
6. Visit the exact HTTPS origin and sign in as `alice` before disablement. After disable,
   sign-in, existing protected reads, session restoration and rotation must reject her.
   The User & Project Management preview remains a simulation, not an admin console.

## Recovery without Console UI or external OIDC

Recovery requires the healthy BFF, identity database, protected recovery custody and
an attended operator. It cannot recover a compromised BFF or lost database by itself.

Stop the local process, explicitly set exceptional mode `bootstrap`, OIDC disabled and
`OK_CONSOLE_LOCAL_IDENTITY_RECOVERY_ENABLED=true` in its protected configuration, then
restart. The existing named Bootstrap verifier authenticates the operator; the fixed
recovery route independently requires `local.users.recover` and the recovery switch:

```sh
node bff/cli/localIdentity.mjs recover named-admin --admin boot-operator
```

This changes only an existing administrator's password, re-enables that account,
advances its revision, revokes its sessions and records an audit event in one transaction.
It does not create a new administrator or reset the initialization marker. Return both
recovery switch and exceptional mode to disabled and restart. Review recovery evidence
and rotate the operator's exceptional credential using the existing custody procedure.
No SQL shortcut or public recovery endpoint is provided. MFA UI/self-service reset and
production recovery acceptance remain excluded.

## Security and compatibility

Ordinary verifiers use Node's maintained scrypt primitive with unique 16-byte salts,
`N=131072,r=8,p=1`, a 256-MiB per-call ceiling and at most two concurrent KDF calls per
BFF process. Reserve sufficient local memory; resource errors fail closed. Profile ID
`scrypt-v1` versions this choice. The existing exceptional verifier parameters remain
unchanged. Ordinary throttling is durable and separate from exceptional throttling:
five failures per principal in 15 minutes block it for 15 minutes, and the shared global
bucket limits rotating usernames. Throttle keys are HMAC digests, not raw usernames.

Account-state validation is installed inside session resolution and rotation, covering
restore as well as protected reads. Login takes a database account lock through session
insertion/audit commit. Disablement increments the account revision and revokes matching
sessions. Rotation retains the original revision and revalidates before returning; any
late session is unusable after disable commits. In-flight reads that began before that
commit may complete; previously disclosed data cannot be retracted.

Administration serializes on the single initialization-state row and rechecks the actor
inside the transaction, protecting last-admin decisions across processes. Audit failure
rolls back account changes/session issuance. Unknown identity/session state denies access;
no cache or in-memory production fallback is added.

`Local` is an explicit new security-method variant; `Local development` is the explicit
Presentation Contract assurance variant. Provider and consumer are updated together;
older closed-enum consumers fail closed. OIDC/Bootstrap/BreakGlass keep their existing
semantics. Local UI labels make no MFA claim. Production local identity is rejected.

In the ordinary-local profile only, external discovery failure leaves local startup/login
available and returns 503 on OIDC routes. Restart after provider recovery to retry discovery;
this MVP adds no discovery-retry scheduler. Invalid trust configuration still fails startup.

## Verification

Use a **disposable** database; tests truncate tables. Never target a deployed database.
With `OK_CONSOLE_TEST_POSTGRES_URL` set through the test environment:

```sh
VITE_CONSOLE_DATA_MODE=bff VITE_CONSOLE_AUTH_MODE=local pnpm build
OK_CONSOLE_TEST_LOCAL_BROWSER=true pnpm test:postgres
env -u OK_CONSOLE_TEST_POSTGRES_URL pnpm exec vitest run bff src/auth src/workspaces src/identity src/App.test.tsx
pnpm lint
pnpm build
```

Integration tests cover verified HTTPS and actual attended CLI execution through a PTY
(Python 3 and OpenSSL required), create/list/login/disable, session reuse rejection,
bootstrap/last-admin/login-disable-rotate races, recovery, audit rollback, independent
throttles and external-provider outage. Browser smoke/component tests cover ordinary
login separately. Skipped database tests do not count as acceptance evidence.
