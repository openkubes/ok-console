import { useState, type FormEvent, type ReactNode } from 'react'
import { ConsoleAuthError, type AuthMode, type LocalAccessCredentials } from './authClient'

export type PrototypeSession = {
  method: 'oidc' | 'local'
  identity: string
  source: string
  assurance: string
  expiresIn: string
  reason?: string
}

type AuthStage = 'entry' | 'oidc-redirect' | 'oidc-review' | 'local' | 'local-review'
type AuthIconName = 'arrow' | 'check' | 'eye' | 'key' | 'lock' | 'shield' | 'user'

const providers = [
  { id: 'openkubes', name: 'OpenKubes Identity', detail: 'Recommended · OIDC federation' },
  { id: 'enterprise', name: 'Enterprise OIDC', detail: 'Configured organization provider' },
]

function AuthIcon({ name, size = 18 }: { name: AuthIconName; size?: number }) {
  const paths: Record<AuthIconName, ReactNode> = {
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
    key: <><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8m-3 3 2 2"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    shield: <><path d="M12 3 20 6v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3Z"/><path d="m9 12 2 2 4-5"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/></>,
  }
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

function SessionReview({ session, title, onEnter, onBack }: { session: PrototypeSession; title: string; onEnter: () => void; onBack: () => void }) {
  return <>
    <div className="auth-heading auth-success-heading"><span className="auth-success-mark"><AuthIcon name="check" size={20}/></span><div><span className="auth-kicker">Identity verified · prototype</span><h1>{title}</h1><p>Review the identity context before entering this Console environment.</p></div></div>
    <dl className="auth-session-review">
      <div><dt>Identity</dt><dd>{session.identity}</dd></div>
      <div><dt>Source</dt><dd>{session.source}</dd></div>
      <div><dt>Assurance</dt><dd>{session.assurance}</dd></div>
      <div><dt>Session</dt><dd>{session.expiresIn}</dd></div>
      <div><dt>Environment</dt><dd><span className="auth-live-dot"/>Community preview</dd></div>
      {session.reason && <div><dt>Audit reason</dt><dd>{session.reason}</dd></div>}
    </dl>
    <div className="auth-boundary"><AuthIcon name="shield"/><div><strong>Identity is not authority</strong><p>Signing in does not approve a Contract, grant an operation, or bypass Policy and point-of-use authorization.</p></div></div>
    <button className="auth-primary" type="button" onClick={onEnter}>Enter Console <AuthIcon name="arrow"/></button>
    <button className="auth-text-button" type="button" onClick={onBack}>Use a different sign-in method</button>
  </>
}

export default function AuthEntry({ onAuthenticated, authMode = 'prototype', onStartOidc, onAuthenticateLocal, serviceError, onRetry }: {
  onAuthenticated: (session: PrototypeSession) => void
  authMode?: AuthMode
  onStartOidc?: () => void
  onAuthenticateLocal?: (credentials: LocalAccessCredentials) => Promise<PrototypeSession>
  serviceError?: string
  onRetry?: () => void
}) {
  const [stage, setStage] = useState<AuthStage>('entry')
  const [provider, setProvider] = useState(providers[0])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [reason, setReason] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [authenticating, setAuthenticating] = useState(false)
  const live = authMode !== 'prototype'
  const oidcEnabled = authMode === 'oidc' || authMode === 'breakglass'
  const localEnabled = authMode === 'bootstrap' || authMode === 'breakglass'
  const availableProviders = live ? (oidcEnabled ? providers.slice(0, 1) : []) : providers
  const localTitle = authMode === 'bootstrap' ? 'Bootstrap access' : authMode === 'breakglass' ? 'Break-glass access' : 'Bootstrap / break-glass'

  const oidcSession: PrototypeSession = {
    method: 'oidc',
    identity: 'Arash Kaffamanesh',
    source: provider.name,
    assurance: 'OIDC · MFA',
    expiresIn: '60 minutes · in-memory prototype',
  }
  const localSession: PrototypeSession = {
    method: 'local',
    identity: username,
    source: 'Local bootstrap / break-glass',
    assurance: 'Password · elevated review required',
    expiresIn: '15 minutes · in-memory prototype',
    reason,
  }
  const localReady = username.trim().length > 0 && password.length > 0 && reason.trim().length >= 12 && acknowledged

  const reset = () => {
    setStage('entry')
    setPassword('')
    setReason('')
    setAcknowledged(false)
    setError('')
  }

  const reviewLocal = async (event: FormEvent) => {
    event.preventDefault()
    if (!localReady || authenticating) return
    if (localEnabled) {
      setAuthenticating(true)
      setError('')
      try {
        const authenticated = await onAuthenticateLocal?.({ username, password, reason: reason.trim() })
        if (!authenticated) throw new ConsoleAuthError('Exceptional local access is not enabled.', false)
        setPassword('')
        onAuthenticated(authenticated)
      } catch (failure) {
        setPassword('')
        setError(failure instanceof ConsoleAuthError ? failure.message : 'Exceptional local access could not be completed.')
      } finally {
        setAuthenticating(false)
      }
      return
    }
    if (username.trim().toLowerCase() === 'blocked') {
      setError('Access denied by the deterministic prototype policy. No account lookup or authentication request was made.')
      return
    }
    setError('')
    setPassword('')
    setStage('local-review')
  }

  return <main className="auth-shell">
    <section className="auth-story" aria-label="OpenKubes trust model">
      <div className="auth-brand"><img src="./openkubes-icon.png" alt="OpenKubes"/><span><strong>OpenKubes</strong><small>Platform Console</small></span></div>
      <div className="auth-story-copy"><span className="auth-kicker">Sovereign platform operations</span><h2>Contracts.<br/>Clusters.<br/><em>Evidence.</em></h2><p>One trusted entry point for platform intent, observed state, and reviewable operations — from local laptop to edge, bare metal, and cloud.</p></div>
      <div className="auth-principles"><span><AuthIcon name="shield"/>Federated by default</span><span><AuthIcon name="lock"/>Least authority</span><span><AuthIcon name="check"/>Evidence-backed</span></div>
      <p className="auth-story-foot">{live ? 'OpenKubes Console · Secure entry' : 'OpenKubes Console Prototype · OK-154'}</p>
    </section>
    <section className="auth-panel" aria-label="Sign in to OpenKubes">
      <div className="auth-card">
        <div className="auth-environment"><span className="auth-live-dot"/><span><small>Environment</small><strong>Community preview</strong></span><em>{live ? (authMode === 'bootstrap' ? 'Bootstrap authentication' : 'Federated authentication') : 'Prototype · no live auth'}</em></div>

        {stage === 'entry' && <>
          <div className="auth-heading"><span className="auth-kicker">Welcome</span><h1>Welcome to OpenKubes</h1><p>{authMode === 'bootstrap' ? 'Use the reviewed bootstrap account to establish the platform before federation is configured.' : 'Sign in with a configured identity provider. Your provider verifies identity; OpenKubes evaluates authority separately.'}</p></div>
          {serviceError && <div className="auth-error" role="alert">{serviceError}{onRetry && <button type="button" className="auth-text-button" onClick={onRetry}>Retry session check</button>}</div>}
          {availableProviders.length > 0 && <div className="auth-provider-list" aria-label="Configured identity providers">
            {availableProviders.map((item, index) => <button type="button" className="auth-provider" key={item.id} onClick={() => { setProvider(item); setStage('oidc-redirect') }}><span className="auth-provider-mark">{index === 0 ? 'OK' : 'ID'}</span><span><strong>Continue with {item.name}</strong><small>{item.detail}</small></span><AuthIcon name="arrow"/></button>)}
          </div>}
          <div className="auth-divider"><span>Exceptional access</span></div>
          {live && !localEnabled ? <button type="button" className="auth-local-entry" disabled><AuthIcon name="key"/><span><strong>Local account not enabled</strong><small>Enable only for bootstrap or break-glass operations</small></span></button> : <button type="button" className="auth-local-entry" onClick={() => setStage('local')}><AuthIcon name="key"/><span><strong>Use a local account</strong><small>Bootstrap / break-glass only · audited</small></span><AuthIcon name="arrow" size={16}/></button>}
          <p className="auth-privacy"><AuthIcon name="lock" size={14}/>No fleet or infrastructure data is exposed before sign-in.</p>
        </>}

        {stage === 'oidc-redirect' && <>
          <button className="auth-back" type="button" onClick={reset}>← All sign-in methods</button>
          <div className="auth-heading"><span className="auth-kicker">Federated sign-in</span><h1>Continue to {provider.name}</h1><p>{oidcEnabled ? 'The Console redirects to the configured provider.' : 'The production Console will redirect to the configured provider.'} OpenKubes never receives your provider password.</p></div>
          <div className="auth-flow-card"><span className="auth-provider-mark">OK</span><div><small>Protocol</small><strong>Authorization Code + PKCE</strong></div><div><small>Return</small><strong>Server-side session boundary</strong></div></div>
          <ol className="auth-flow-steps"><li><span>1</span><div><strong>Redirect to identity provider</strong><p>Provider performs authentication and MFA.</p></div></li><li><span>2</span><div><strong>Validate secure return</strong><p>State, nonce, issuer, audience, and PKCE are checked server-side.</p></div></li><li><span>3</span><div><strong>Create bounded Console session</strong><p>No token is stored in browser storage.</p></div></li></ol>
          <button className="auth-primary" type="button" onClick={() => oidcEnabled ? onStartOidc?.() : setStage('oidc-review')}>{oidcEnabled ? 'Continue to identity provider' : 'Simulate identity provider return'} <AuthIcon name="arrow"/></button>
          <p className="auth-simulation">{oidcEnabled ? 'Secure redirect · server-side PKCE, State, Nonce, and session boundary' : 'Simulation only · no redirect, token, cookie, or network request'}</p>
        </>}

        {stage === 'oidc-review' && <SessionReview session={oidcSession} title="Identity verified" onEnter={() => onAuthenticated(oidcSession)} onBack={reset}/>} 

        {stage === 'local' && <>
          <button className="auth-back" type="button" onClick={reset}>← Back to sign-in</button>
          <div className="auth-heading"><span className="auth-kicker auth-kicker-warning">Exceptional access</span><h1>{localTitle}</h1><p>Use a local account only when federation is not yet configured or unavailable.</p></div>
          <div className="auth-warning"><AuthIcon name="shield"/><div><strong>This is not the everyday login path</strong><p>{localEnabled ? 'This attempt is rate-limited, short-lived, reason-bound, and recorded as durable audit Evidence by the BFF.' : 'A production attempt requires rate limiting, MFA where available, short expiry, immutable audit evidence, and an operational reason.'}</p></div></div>
          <form className="auth-local-form" onSubmit={reviewLocal}>
            <label><span>Local username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={128} placeholder="bootstrap-admin"/></label>
            <label><span>Password</span><span className="auth-password"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" maxLength={1024} placeholder="Enter local password"/><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}><AuthIcon name="eye" size={17}/></button></span></label>
            <label><span>Operational reason</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is federated access unavailable?" rows={3} minLength={12} maxLength={512}/><small>12–512 characters · immutable audit evidence · do not include secrets</small></label>
            <label className="auth-ack"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}/><span>I acknowledge this exceptional access would be time-bound and audited.</span></label>
            {error && <div className="auth-error" role="alert">{error}</div>}
            <button className="auth-primary" type="submit" disabled={!localReady || authenticating}>{localEnabled ? (authenticating ? 'Authenticating…' : 'Authenticate and enter Console') : 'Review local session'} <AuthIcon name="arrow"/></button>
          </form>
          <p className="auth-simulation">{localEnabled ? 'Credentials are sent only to the same-origin exceptional-access BFF boundary.' : <>Prototype hint: username <code>blocked</code> demonstrates a denied attempt.</>}</p>
        </>}

        {stage === 'local-review' && <SessionReview session={localSession} title="Review break-glass session" onEnter={() => onAuthenticated(localSession)} onBack={reset}/>} 
      </div>
      <footer className="auth-panel-footer"><span>Privacy</span><span>Security</span><span>OpenKubes</span><small>console.openkubes.io/v0alpha1</small></footer>
    </section>
  </main>
}
