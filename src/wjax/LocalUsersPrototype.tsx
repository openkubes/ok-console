import { useState, type FormEvent } from 'react'

type Role = 'Viewer' | 'Editor' | 'Project Admin'
type LocalUser = { id: number; username: string; role: Role; cluster: string; namespace: string; enabled: boolean }

const targets = [
  { cluster: 'kind-wjax-demo', namespace: 'wjax-demo' },
  { cluster: 'kind-wjax-demo', namespace: 'developer-workspaces' },
] as const

/** Intent-only W-JAX prototype: no credentials, API calls, persistence, or Kubernetes writes. */
export default function LocalUsersPrototype() {
  const [users, setUsers] = useState<LocalUser[]>([])
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<Role>('Viewer')
  const [target, setTarget] = useState(0)
  const [error, setError] = useState('')
  const create = (event: FormEvent) => {
    event.preventDefault()
    const name = username.trim()
    if (!/^[a-z][a-z0-9._-]{2,31}$/i.test(name)) {
      setError('Use 3–32 letters, digits, dots, underscores or hyphens; start with a letter.')
      return
    }
    if (users.some((user) => user.username.toLowerCase() === name.toLowerCase())) {
      setError('That demo username already exists.')
      return
    }
    setUsers((previous) => [...previous, { id: Date.now(), username: name, role, ...targets[target], enabled: true }])
    setUsername('')
    setError('')
  }
  return <section className="panel" aria-labelledby="wjax-users-title" style={{ marginBlock: 20 }}>
    <div className="panel-title"><div><span className="eyebrow">W-JAX · OK-214 · Interface prototype</span><h2 id="wjax-users-title">Local users & namespace access</h2></div><span className="count-badge">{users.length}</span></div>
    <p><strong>Simulation only.</strong> Entries live in this browser tab's memory, vanish on refresh, and do not create accounts, accept passwords, authenticate users, write Kubernetes RBAC or change access to Developer Workspaces.</p>
    <form onSubmit={create} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end', marginBlock: 16 }}>
      <label>Username<br/><input aria-label="Demo username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="developer01" maxLength={32} required style={{ padding: 10, marginTop: 5 }}/></label>
      <label>Cluster / namespace<br/><select aria-label="Demo namespace" value={target} onChange={(event) => setTarget(Number(event.target.value))} style={{ padding: 10, marginTop: 5 }}>{targets.map((item, index) => <option key={index} value={index}>{item.cluster} / {item.namespace}</option>)}</select></label>
      <label>Role<br/><select aria-label="Demo role" value={role} onChange={(event) => setRole(event.target.value as Role)} style={{ padding: 10, marginTop: 5 }}><option>Viewer</option><option>Editor</option><option>Project Admin</option></select></label>
      <button className="primary-button" type="submit">Add demo user</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <div className="wjax-table" style={{ overflowX: 'auto' }}><table><caption>Proposed access assignments — not effective permissions</caption><thead><tr><th scope="col">User</th><th scope="col">Target</th><th scope="col">Role</th><th scope="col">Demo status</th><th scope="col">Action</th></tr></thead><tbody>
      {users.map((user) => <tr key={user.id}><th scope="row">{user.username}</th><td>{user.cluster} / {user.namespace}</td><td>{user.role}</td><td>{user.enabled ? 'Proposed' : 'Disabled (demo)'}</td><td><button className="secondary-button" type="button" onClick={() => setUsers((previous) => previous.map((item) => item.id === user.id ? { ...item, enabled: !item.enabled } : item))}>{user.enabled ? 'Disable' : 'Enable'}</button> <button className="text-button" type="button" onClick={() => setUsers((previous) => previous.filter((item) => item.id !== user.id))}>Remove</button></td></tr>)}
    </tbody></table>{users.length === 0 && <p>No demo users yet. Add one to preview the assignment workflow.</p>}</div>
    <p style={{ marginTop: 12, fontSize: 13 }}>Architecture: a future trusted local identity service must handle password verification and sessions; audited access proposals must be authorized separately and enforced by target-cluster Kubernetes RBAC. This prototype grants no permissions.</p>
  </section>
}
