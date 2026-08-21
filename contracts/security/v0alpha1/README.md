# Console security contract v0alpha1

`auth.console.openkubes.io/v0alpha1` separates the browser-safe session
projection from the internal point-of-use authorization context.

## Kinds

- `ConsoleSession` is the minimal authenticated projection allowed to reach the
  browser. It contains no cookie value, provider token, issuer subject, OIDC
  claims, CSRF secret, authorization code or PKCE verifier.
- `AuthorizationContext` is server-internal. It binds the opaque session to a
  stable mapped subject, environment, tenants, permissions, assurance, idle and
  absolute expiry, and optional revocation time.

The durable provider join is the trusted server-side tuple `providerId +
subjectId`; only the mapped internal subject ID is exposed in `ConsoleSession`.
Email and display name never grant membership or permission.

## Point-of-use rules

Every request supplies an exact environment, optional tenant, permission and
assurance requirement. Unknown versions, malformed context, revocation, either
expiry, scope mismatch, missing permission or insufficient assurance fail
closed. The evaluator never adds permissions and never extends a session.

This contract does not issue a cookie, validate an OIDC token or select a
session store. Those forcing implementation choices remain separate reviewed
steps in OK-163.
