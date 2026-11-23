import { accessTargetState, isObservedSource, type AccessInspectionRow, type AccessTargetState } from './accessInspection'
import { readAccessInspectionFixture } from './accessInspectionFixture'
import './identity.css'

const statusClass: Record<AccessTargetState, string> = {
  Proposed: 'pending', 'Not verified': 'read-only', Unreachable: 'failed', Unknown: 'unknown', Verified: 'ready', Stale: 'pending',
}

function boundary(rows: readonly AccessInspectionRow[]) {
  const fixtures = rows.filter((row) => !isObservedSource(row)).length
  if (rows.length === 0) return 'No targets to inspect'
  if (fixtures === rows.length) return 'Fixture data · no target-cluster evidence'
  if (fixtures > 0) return 'Mixed sources · fixture rows are never verified'
  return 'Console BFF data · each target shows its own evidence state'
}

export default function UserProjectManagement({ rows = readAccessInspectionFixture() }: { rows?: readonly AccessInspectionRow[] }) {
  return <div className="identity-preview">
    <header className="page-title"><div><span className="eyebrow">Access inspection</span><h1>User &amp; Project Management</h1><p>Read-only subjects, Project references and namespace targets.</p></div><span className="prototype-badge">Preview</span></header>
    <aside className="identity-disclosure" aria-label="Data boundaries"><strong>{boundary(rows)}</strong><p>Rows marked Fixture are illustrative. “Verified” means target-cluster evidence was observed. Target-cluster Kubernetes RBAC is the only authority; Project membership alone grants no permissions.</p></aside>
    <section className="panel identity-section" aria-labelledby="identity-targets-title">
      <div className="panel-title"><div><span className="eyebrow">Subjects &amp; targets</span><h2 id="identity-targets-title">Access inspection targets</h2></div></div>
      <p>Project identifies an ADR-045 Enterprise Workspace by tenantId and projectId.</p>
      <div className="identity-table" role="region" aria-label="Access inspection targets" tabIndex={0}><table><caption>Per-target state and evidence · read-only</caption><thead><tr><th scope="col">Subject</th><th scope="col">Project reference</th><th scope="col">Namespace target</th><th scope="col">Access state</th><th scope="col">Evidence summary</th></tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={5}>No targets to inspect.</td></tr> : rows.map((row) => {
        const state = accessTargetState(row)
        const fixture = !isObservedSource(row)
        const reachability = row.clusterReachable === true ? 'Reachable' : row.clusterReachable === false ? 'Unreachable' : 'Unknown'
        return <tr key={row.id}>
          <th scope="row">{row.subject.kind}: {row.subject.displayName ?? row.subject.subject}<small>Subject: {row.subject.subject}</small><small>Issuer: {row.subject.issuer}</small></th>
          <td>tenantId: {row.project.tenantId}<small>projectId: {row.project.projectId}</small></td>
          <td>{row.target.clusterId} / {row.target.namespace}<small>namespaceUid: {row.target.namespaceUid}</small><small>{fixture ? `Reachability (illustrative): ${reachability}` : `Reachability: ${reachability}`}</small></td>
          <td><span className={`status status-${statusClass[state]}`} data-access-state={state}>{state}</span><small>Source: {fixture ? 'Fixture' : 'Console BFF'}</small></td>
          <td>{row.evidence ? <>{fixture && <small>Illustrative evidence (fixture, not observed)</small>}<span>Kind: {row.evidence.kind}</span><small>Observed at: {row.evidence.observedAt ?? 'Unknown'}</small><small>Freshness: {row.evidence.freshness ?? 'Unknown'}</small>{row.evidence.binding && <small>Role reference: {row.evidence.binding.roleRef}</small>}{row.evidence.reasons?.map((reason, index) => <small key={`${reason.code}-${index}`}>Reason: {reason.code}</small>)}</> : 'No target-cluster evidence'}</td>
        </tr>
      })}</tbody></table></div>
    </section>
  </div>
}
