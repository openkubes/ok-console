import { useRef, useState, type FormEvent } from 'react'
import './identity.css'

type Role = 'Viewer' | 'Editor' | 'Project Admin'
type PreviewUser = { id: number; username: string; role: Role; namespace: string; enabled: boolean }

// Illustrative namespaces only: never sourced from cluster inventory or used for authorization.
const namespaces = ['project-preview', 'developer-workspaces'] as const

/** Intent-only preview: no credentials, API calls, persistence, or permission changes. */
export default function UserProjectManagement() {
  const [users, setUsers] = useState<PreviewUser[]>([])
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<Role>('Viewer')
  const [namespace, setNamespace] = useState<string>(namespaces[0])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const nextId = useRef(0)
  const usernameInput = useRef<HTMLInputElement>(null)

  const create = (event: FormEvent) => {
    event.preventDefault()
    const name = username.trim()
    if (!/^[a-z][a-z0-9._-]{2,31}$/i.test(name)) {
      setError('Use 3–32 letters, digits, dots, underscores or hyphens; start with a letter.')
      usernameInput.current?.focus()
      return
    }
    if (users.some((user) => user.username.toLowerCase() === name.toLowerCase())) {
      setError('That preview username already exists.')
      usernameInput.current?.focus()
      return
    }
    setUsers((previous) => [...previous, { id: ++nextId.current, username: name, role, namespace, enabled: true }])
    setUsername('')
    setError('')
    setNotice(`${name} added to this preview. No account or access was created.`)
    usernameInput.current?.focus()
  }

  return <div className="identity-preview">
    <header className="page-title"><div><span className="eyebrow">Identity &amp; access</span><h1>User &amp; Project Management</h1><p>Explore user and namespace access proposals before connecting an identity service.</p></div><span className="prototype-badge">Preview</span></header>
    <aside className="identity-disclosure" aria-label="Preview boundaries"><strong>Simulation only · no effective access</strong><p>All entries stay in page memory and reset on reload or when you leave this page. No accounts, authentication, credentials, Kubernetes RBAC or Developer Workspace access are created or changed. No access-management requests are sent.</p></aside>
    <section className="panel identity-section" aria-labelledby="identity-users-title">
      <div className="panel-title"><div><span className="eyebrow">01 · Users</span><h2 id="identity-users-title">Preview users</h2></div><span className="count-badge" aria-label={`${users.length} preview users`}>{users.length}</span></div>
      <p>Add a username with an illustrative assignment. Role presets describe intent only.</p>
      <form className="identity-form" onSubmit={create} noValidate aria-label="Add preview user">
        <div className="identity-field"><label htmlFor="identity-username">Username</label><input ref={usernameInput} id="identity-username" value={username} onChange={(event) => { setUsername(event.target.value); setError('') }} placeholder="developer01" maxLength={32} required autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={`identity-username-hint${error ? ' identity-error' : ''}`}/><small id="identity-username-hint">3–32 characters; start with a letter.</small></div>
        <div className="identity-field"><label htmlFor="identity-namespace">Example namespace</label><select id="identity-namespace" value={namespace} onChange={(event) => setNamespace(event.target.value)} aria-describedby="identity-target-hint">{namespaces.map((item) => <option key={item}>{item}</option>)}</select><small id="identity-target-hint">Illustrative targets, not cluster inventory.</small></div>
        <div className="identity-field"><label htmlFor="identity-role">Proposed role</label><select id="identity-role" value={role} onChange={(event) => setRole(event.target.value as Role)}><option>Viewer</option><option>Editor</option><option>Project Admin</option></select><small>No permissions are granted.</small></div>
        <button className="primary-button" type="submit">Add preview user</button>
      </form>
      {error && <p id="identity-error" className="identity-error" role="alert">{error}</p>}
      <p className="identity-announcement" role="status">{notice}</p>
      {users.length === 0 ? <div className="identity-empty"><h3>No preview users yet</h3><p>Add your first username to explore proposed access. No sign-in account will be created.</p></div> : <div className="identity-table" role="region" aria-label="Preview users table" tabIndex={0}><table><caption>Users in this preview · not sign-in accounts</caption><thead><tr><th scope="col">Username</th><th scope="col">Preview state</th><th scope="col">Actions</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><th scope="row">{user.username}</th><td><span className={`status ${user.enabled ? 'status-pending' : 'status-unknown'}`}>{user.enabled ? 'Proposed' : 'Disabled in preview'}</span></td><td><div className="identity-actions"><button className="secondary-button" type="button" aria-label={`${user.enabled ? 'Disable' : 'Enable'} ${user.username} in preview`} onClick={() => {
        setUsers((previous) => previous.map((item) => item.id === user.id ? { ...item, enabled: !item.enabled } : item))
        setNotice(`${user.username} ${user.enabled ? 'disabled' : 'enabled'} in preview only. Effective access is unchanged.`)
      }}>{user.enabled ? 'Disable' : 'Enable'}</button><button className="text-button" type="button" aria-label={`Remove ${user.username} from preview`} onClick={() => {
        setUsers((previous) => previous.filter((item) => item.id !== user.id))
        setNotice(`${user.username} and the proposed assignment removed from this preview.`)
        usernameInput.current?.focus()
      }}>Remove</button></div></td></tr>)}</tbody></table></div>}
    </section>
    <section className="panel identity-section identity-projects" aria-labelledby="identity-projects-title"><div><span className="eyebrow">02 · Projects</span><h2 id="identity-projects-title">Project planning</h2><p>Demo only. Projects are not connected in this preview. The example namespaces above let you discuss assignment intent without creating a project or enforcing access across clusters.</p></div><span className="prototype-badge">Not connected</span></section>
    <section className="panel identity-section" aria-labelledby="identity-assignments-title"><div className="panel-title"><div><span className="eyebrow">03 · Access Assignments</span><h2 id="identity-assignments-title">Proposed access</h2></div></div><p>Each preview user has one illustrative namespace assignment. These are proposals, never effective permissions.</p>
      {users.length === 0 ? <div className="identity-empty"><h3>No proposed assignments</h3><p>Assignments appear here when you add a preview user.</p></div> : <div className="identity-table" role="region" aria-label="Proposed assignments table" tabIndex={0}><table><caption>In-memory proposals · no cluster binding or RBAC enforcement</caption><thead><tr><th scope="col">Username</th><th scope="col">Example namespace</th><th scope="col">Proposed role</th><th scope="col">Proposal state</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><th scope="row">{user.username}</th><td>{user.namespace}</td><td>{user.role}</td><td><span className={`status ${user.enabled ? 'status-pending' : 'status-unknown'}`}>{user.enabled ? 'Proposed' : 'Paused in preview'}</span></td></tr>)}</tbody></table></div>}
      <p className="identity-footnote">Real identity verification, sessions and authorized access enforcement require future trusted services and reviewed contracts.</p>
    </section>
  </div>
}
