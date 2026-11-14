import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { capabilityPresentation, clusterPresentation, conservativeVerdict, evidencePresentation, observationPresentation, observedText, overviewPresentation, placementPresentation } from './observationPresentation'
import { useObservationSnapshot } from './useObservationSnapshot'
import AuthEntry, { type PrototypeSession } from './auth/AuthEntry'
import DiagnosticWidget from './DiagnosticWidget'
import { PoweredBy, useBrandTerms, useBranding } from './branding/BrandingContext'
import { useDeploymentPolicy } from './deploymentPolicy'
import DeveloperWorkspaces from './workspaces/DeveloperWorkspaces'
import { consoleAuth, ConsoleAuthError, type ConsoleAuthClient } from './auth/authClient'
import { consoleDataMode } from './data/consoleData'
import { platformFixture } from './data/fixtures'
import { ConsoleDataError } from './data/bffAdapter'
import type { AgentDefinition, Capability, Cluster, EvidenceRef, ExternalClusterConnection, ExternalClusterManagementMode, ExternalClusterRegistrationDraft, PlatformSnapshot, Readiness, WorkloadClaim } from './domain/contracts'

import { wjaxLocalPreviewEnabled } from './wjax/localPreview'

// Excluded from production builds; fetched only when this local demo route opens.
const WjaxClusterView = import.meta.env.DEV ? lazy(() => import('./wjax/WjaxClusterView')) : null
const UserProjectManagement = import.meta.env.DEV ? lazy(() => import('./identity/UserProjectManagement')) : null

type Page = 'wjax' | 'users' | 'overview' | 'clusters' | 'workloads' | 'agents' | 'workspaces' | 'capabilities' | 'evidence' | 'create' | 'register'
type IconName = Exclude<Page, 'wjax'> | 'search' | 'bell' | 'chevron' | 'shield' | 'cube' | 'arrow' | 'menu' | 'x' | 'check' | 'clock' | 'external' | 'code' | 'terminal' | 'spark'

const publicDemoBuild = () => import.meta.env.VITE_CONSOLE_PUBLIC_DEMO === 'true'

const NAV: Array<{ id: Exclude<Page, 'wjax'>; label: string; caption: string }> = [
  { id: 'overview', label: 'Platform Overview', caption: 'Fleet & posture' },
  { id: 'clusters', label: 'Clusters', caption: 'Lifecycle contracts' },
  { id: 'workloads', label: 'Workloads', caption: 'Claims & placement' },
  { id: 'agents', label: 'AI Agents', caption: 'Catalog & deployments' },
  { id: 'workspaces', label: 'Developer Workspaces', caption: 'Preview · code & evidence' },
  { id: 'capabilities', label: 'Capabilities', caption: 'Contract catalog' },
  { id: 'evidence', label: 'Evidence & Audit', caption: 'Receipts & provenance' },
]

const pageFromHash = (): Page => {
  const value = window.location.hash.replace('#/', '').split('/')[0] as Page
  if (value === 'wjax' && wjaxLocalPreviewEnabled) return 'wjax'
  if (value === 'users' && wjaxLocalPreviewEnabled) return 'users'
  return [...NAV.map((item) => item.id), 'create', 'register'].includes(value) ? value : 'overview'
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    users: <><path d="M12 3 20 6v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3Z"/><path d="m9 12 2 2 4-5"/></>,

    overview: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    clusters: <><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z"/><path d="m4 12 8 4.5 8-4.5"/><path d="m4 16.5 8 4.5 8-4.5"/></>,
    workloads: <><path d="M4 5h16v14H4z"/><path d="M4 9h16M8 3v4M16 3v4"/></>,
    agents: <><circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2M8 8H5m14 0h-3M12 4V2"/><circle cx="10.5" cy="8" r=".5" fill="currentColor"/><circle cx="13.5" cy="8" r=".5" fill="currentColor"/></>,
    workspaces: <><rect x="3" y="4" width="18" height="14" rx="2"/><path d="m8 8-3 3 3 3m8-6 3 3-3 3M9 21h6m-3-3v3"/></>,
    capabilities: <><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3m13 5h3a2 2 0 0 0 2-2v-3"/><circle cx="12" cy="12" r="4"/></>,
    evidence: <><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13l2 2 4-5"/></>,
    create: <><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></>,
    register: <><path d="M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z"/><path d="M4 12l8 4.5 8-4.5M4 16.5l8 4.5 8-4.5"/><path d="M19 3v5M16.5 5.5h5"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    shield: <><path d="M12 3 20 6v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3Z"/><path d="m9 12 2 2 4-5"/></>,
    cube: <><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 7 9 5v10l-9-5V7Zm18 0-9 5v10l9-5V7Z"/></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
    x: <path d="m6 6 12 12M18 6 6 18"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/></>,
    code: <><path d="m8 9-4 3 4 3m8-6 4 3-4 3m-2-9-4 12"/></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></>,
    spark: <><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Z"/><path d="m18 15 .8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z"/></>,
  }
  return <svg aria-hidden="true" className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

function StatusBadge({ status }: { status: Readiness | 'Approved' | 'Denied' | 'Supported' | 'Read only' | 'Incompatible' }) {
  const icon = status === 'Ready' || status === 'Approved' || status === 'Supported' ? 'check' : status === 'Pending' ? 'clock' : 'x'
  return <span className={`status status-${status.toLowerCase().replace(' ', '-')}`}><Icon name={icon} size={13}/>{status}</span>
}

function ObservationLabel({ presentation }: { presentation: ReturnType<typeof observationPresentation> }) {
  return <span className="observation-label">{presentation.current && <span className="live-dot"/>}{presentation.label}</span>
}

function EvidenceOutcome({ item, fixture = false }: { item: EvidenceRef; fixture?: boolean }) {
  const presentation = evidencePresentation(item, fixture)
  if (fixture) return <StatusBadge status={item.outcome}/>
  return <span><ObservationLabel presentation={presentation}/>{(item.freshness !== 'Current' && item.outcome !== 'Unknown') || presentation.stale || (item.immutable && presentation.verdict !== 'Unknown')
    ? <span className="status status-unknown">Last observed: {item.outcome}</span>
    : <StatusBadge status={presentation.verdict === 'Unknown' ? 'Unknown' : item.outcome}/>}</span>
}

function FreshnessWarning({ data, freshness }: { data: PlatformSnapshot; freshness?: PlatformSnapshot['freshness'] }) {
  if ((data.source !== 'bff' || freshness === 'Current') && !(data.warnings?.length)) return null
  return <div className="data-warning" role="status"><Icon name="clock"/><div><strong>{freshness === 'Stale' ? 'Some observations are stale' : freshness !== 'Current' && data.source === 'bff' ? 'Observation unavailable - readiness Unknown' : 'Platform data is partially degraded'}</strong><span>{data.warnings?.join(' ') || 'Readiness is shown as observed and is not inferred.'}</span></div></div>
}

function Metric({ label, value, note, tone = 'blue' }: { label: string; value: string | number; note: string; tone?: string }) {
  return <article className={`metric metric-${tone}`}><div className="metric-top"><span>{label}</span><span className="metric-mark"/></div><strong>{value}</strong><small>{note}</small></article>
}

function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className="page-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</header>
}

function EvidenceLink({ id, evidence, onSelect }: { id: string; evidence: EvidenceRef[]; onSelect: (item: EvidenceRef) => void }) {
  const item = evidence.find((entry) => entry.id === id)
  if (!item) return null
  return <button className="evidence-link" onClick={() => onSelect(item)}><Icon name="evidence" size={15}/>{item.revision}<Icon name="chevron" size={14}/></button>
}

function BrandMark() {
  const { logoUrl } = useBranding()
  return <img src={logoUrl} alt=""/>
}

function EmptyLoading() {
  return <main className="loading"><BrandMark/><p>Loading contract-aligned platform view…</p></main>
}

function AuthLoading() {
  return <main className="loading"><BrandMark/><p>Checking secure Console session…</p></main>
}

function LoadFailure({ error, retry }: { error: ConsoleDataError; retry: () => void }) {
  return <main className="loading load-failure" role="alert"><BrandMark/><span className="eyebrow">Read-only Console</span><h1>Platform data is unavailable</h1><p>{error.message}</p><small>{error.code}{error.correlationId ? ` · Correlation ID ${error.correlationId}` : ''}</small>{error.retryable && <button className="primary-button" onClick={retry}>Retry safely</button>}</main>
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="empty-state" role="status"><span className="cluster-symbol"><Icon name="cube"/></span><h2>{title}</h2><p>{description}</p></div>
}

function clusterPlaneLabel(cluster: Cluster): string {
  if (cluster.role === 'Management plane') return 'Management plane'
  if (cluster.profile.toLowerCase().includes('infrastructure host')) return 'Infra plane'
  return 'Worker power'
}

function OverviewMetric({ suppressed, ...props }: Parameters<typeof Metric>[0] & { suppressed: boolean }) {
  return <Metric {...props} value={suppressed ? 'Unavailable' : props.value} note={suppressed ? 'Unavailable' : props.note}/>
}

function Overview({ data, identity, openCluster, openEvidence, publicDemo = false }: { data: PlatformSnapshot; identity: string; openCluster: (c: Cluster) => void; openEvidence: (e: EvidenceRef) => void; publicDemo?: boolean }) {
  const branding = useBranding()
  const terms = useBrandTerms()
  const ready = data.clusters.filter((cluster) => cluster.readiness === 'Ready').length
  const presentation = overviewPresentation(data)
  const overview = data.overview
  const observedMetric = (value: number | null) => value ?? 'Unavailable'
  return <>
    <PageTitle eyebrow="Platform posture" title={publicDemo ? `Welcome to ${branding.productShortName}` : `Hello ${identity.trim().split(/\s+/)[0]}`} description={publicDemo ? `Explore a simulated sovereign ${terms.platformNoun} platform through contracts, clusters, and evidence.` : `One evidence-backed view across your sovereign ${terms.platformNoun} platforms.`} action={<span className="snapshot"><ObservationLabel presentation={presentation}/> · {data.source === 'bff' ? 'BFF observation · ' : ''}{new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}/>
    <FreshnessWarning data={data} freshness={data.freshness}/>
    {data.source === 'bff' && data.evidence.some(item => item.immutable) && <p className="receipt-note">Immutable Evidence receipts are retained separately from mutable observations.</p>}
    <section className="metrics-grid" aria-label="Platform metrics">
      <OverviewMetric suppressed={data.source === 'bff' && !presentation.current} label="Clusters" value={overview?.clusters.total ?? data.clusters.length} note={`${overview?.clusters.ready ?? ready} ready · ${overview ? Number(overview.managementPlane !== null) : 1} management plane`} tone="blue"/>
      <OverviewMetric suppressed={data.source === 'bff' && !presentation.current} label="Capabilities" value={overview ? observedMetric(overview.capabilities.total) : data.capabilities.length} note={`${overview ? observedMetric(overview.capabilities.ready) : 5} conformant · ${overview ? observedMetric(overview.capabilities.pending) : 2} converging`} tone="green"/>
      <OverviewMetric suppressed={data.source === 'bff' && !presentation.current} label="Workload claims" value={overview ? observedMetric(overview.workloadClaims.total) : data.claims.length} note={`${overview ? observedMetric(overview.workloadClaims.ready) : 1} ready · ${overview ? observedMetric(overview.workloadClaims.pending) : 2} in progress`} tone="orange"/>
      <OverviewMetric suppressed={data.source === 'bff' && !presentation.current} label="Open findings" value={overview ? observedMetric(overview.openFindings.total) : 2} note={`${overview ? observedMetric(overview.openFindings.critical) : 0} critical policy violations`} tone="red"/>
    </section>
    <section className="section-block">
      <div className="section-heading"><div><span className="eyebrow">Fleet</span><h2>Cluster posture</h2></div><button className="text-button" onClick={() => window.location.hash = '#/clusters'}>View all clusters <Icon name="arrow" size={16}/></button></div>
      {data.clusters.length === 0 ? <EmptyState title="No clusters observed" description="The Console BFF returned a valid empty fleet. No readiness is inferred."/> : <div className="cluster-grid">
        {data.clusters.map((cluster) => <article key={cluster.id} className={`cluster-card ${cluster.role === 'Management plane' ? 'management' : ''}`}>
          {cluster.role === 'Management plane'
            ? <div className="management-ribbon"><Icon name="shield" size={13}/> {clusterPlaneLabel(cluster)}</div>
            : <div className={`plane-ribbon ${cluster.profile.toLowerCase().includes('infrastructure host') ? 'infra-ribbon' : 'worker-ribbon'}`}><Icon name="cube" size={13}/> {clusterPlaneLabel(cluster)}</div>}
          <button className="card-main" onClick={() => openCluster(cluster)}>
            <div className="cluster-card-head"><div className="cluster-symbol"><Icon name="cube" size={21}/></div><StatusBadge status={data.source === 'bff' && !clusterPresentation(cluster, data).current ? 'Unknown' : cluster.readiness}/></div>
            <h3>{cluster.name}</h3><p>{cluster.profile}</p><ObservationLabel presentation={clusterPresentation(cluster, data)}/>
            <dl className="mini-spec"><div><dt>Provider</dt><dd>{cluster.provider}</dd></div><div><dt>Region</dt><dd>{cluster.region}</dd></div><div><dt>Version</dt><dd>{cluster.version}</dd></div></dl>
          </button>
          <footer><span>{cluster.capabilityCount ?? cluster.capabilities.length} capabilities</span><EvidenceLink id={cluster.evidenceId} evidence={data.evidence} onSelect={openEvidence}/></footer>
        </article>)}
      </div>}
    </section>
    <section className="two-column section-block">
      <article className="panel"><div className="panel-title"><div><span className="eyebrow">Claims</span><h2>Recent placements</h2></div><span className="count-badge">{data.claims.length}</span></div>{data.claims.map((claim) => <button className="activity-row" key={claim.id} onClick={() => window.location.hash = '#/workloads'}><span className="activity-icon"><Icon name="workloads" size={17}/></span><span className="activity-copy"><strong>{claim.name}</strong><small>{claim.owner} → {claim.targetCluster}</small></span><StatusBadge status={data.source === 'bff' && !placementPresentation(claim, data).current ? 'Unknown' : claim.readiness}/><ObservationLabel presentation={placementPresentation(claim, data)}/><Icon name="chevron" size={16}/></button>)}</article>
      <article className="panel trust-panel"><div className="panel-title"><div><span className="eyebrow">Trust model</span><h2>Why is the platform ready?</h2></div><Icon name="shield" size={22}/></div><p>Every status shown here resolves to a contract revision, freshness-bound observation, or immutable receipt.</p><div className="trust-chain"><span>Intent</span><i/><span>Observed</span><i/><span>Evidence</span></div><button className="secondary-button" onClick={() => window.location.hash = '#/evidence'}>Explore evidence chain <Icon name="arrow" size={16}/></button></article>
    </section>
  </>
}

function Clusters({ data, openCluster, openEvidence }: { data: PlatformSnapshot; openCluster: (c: Cluster) => void; openEvidence: (e: EvidenceRef) => void }) {
  const { clusterLifecycleAvailable } = useDeploymentPolicy()
  const ready = data.clusters.filter((cluster) => cluster.readiness === 'Ready' && (data.source !== 'bff' || clusterPresentation(cluster, data).current)).length
  return <>
    <PageTitle eyebrow="Contract inventory" title="Clusters" description="Lifecycle posture without the Kubernetes object noise." action={clusterLifecycleAvailable ? <div className="title-actions"><button className="secondary-button" onClick={() => window.location.hash = '#/register'}><Icon name="register"/>Register Existing Cluster</button><button className="primary-button" onClick={() => window.location.hash = '#/create'}><Icon name="create"/>Create Cluster</button></div> : <span className="lifecycle-unavailable-badge" role="note">Read-only installation · cluster lifecycle unavailable</span>}/>
    <FreshnessWarning data={data} freshness={data.clusterListFreshness}/>
    {wjaxLocalPreviewEnabled && (
      <section aria-label="W-JAX local kind lab" style={{ padding: '18px 20px', marginBottom: 18, border: '1px solid #65a5d255', borderRadius: 12, background: '#e8f5ff' }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <strong style={{ color: '#15375b' }}>kind-wjax-demo · Local lab</strong>
            <div style={{ marginTop: 5, color: '#37546c', fontSize: 13 }}>Read-only Kubernetes observation · Namespace wjax-demo · Not included in fixture cluster totals</div>
          </div>
          <a href="#/wjax" style={{ borderRadius: 8, padding: '10px 14px', color: '#fff', background: '#1059b2', textDecoration: 'none', fontWeight: 600 }}>View Deployments &amp; Pods →</a>
        </div>
      </section>
    )}
    <div className="filter-bar"><label className="search-field"><Icon name="search"/><span className="sr-only">Search clusters</span><input placeholder="Search clusters"/></label><button className="filter-chip active">All · {data.clusters.length}</button><button className="filter-chip">Ready · {ready}</button><button className="filter-chip">Attention · {data.clusters.length - ready}</button></div>
    <section className="table-panel">
      <div className="table-head cluster-columns"><span>Cluster</span><span>Role & profile</span><span>Provider</span><span>Readiness</span><span>Evidence</span><span/></div>
      {data.clusters.length === 0 ? <EmptyState title="No clusters found" description="This is a valid empty contract response. Register and Create flows remain separate, guarded prototypes."/> : data.clusters.map((cluster) => <div className={`table-row cluster-columns ${cluster.role === 'Management plane' ? 'management-row' : ''}`} key={cluster.id}>
        <button className="cluster-name-cell" onClick={() => openCluster(cluster)}><span className="cluster-symbol small"><Icon name={cluster.role === 'Management plane' ? 'shield' : 'cube'} size={18}/></span><span><strong>{cluster.name}</strong><small>{cluster.version} · {cluster.region}</small></span></button>
        <span><strong>{cluster.role}</strong><small>{cluster.profile}</small></span><span>{cluster.provider}</span><span><StatusBadge status={data.source === 'bff' && !clusterPresentation(cluster, data).current ? 'Unknown' : cluster.readiness}/><ObservationLabel presentation={clusterPresentation(cluster, data)}/></span><EvidenceLink id={cluster.evidenceId} evidence={data.evidence} onSelect={openEvidence}/><button className="icon-button" aria-label={`Open ${cluster.name}`} onClick={() => openCluster(cluster)}><Icon name="chevron"/></button>
      </div>)}
    </section>
  </>
}

function ClusterDetail({ cluster, data, detailError, close, openEvidence, openShell }: { cluster: Cluster; data: PlatformSnapshot; detailError?: ConsoleDataError; close: () => void; openEvidence: (e: EvidenceRef) => void; openShell: (cluster: Cluster) => void }) {
  const [tab, setTab] = useState('Overview')
  const clusterCapabilities = data.capabilities.filter((capability) => cluster.capabilities.includes(capability.id))
  const presentation = clusterPresentation(cluster, data)
  const stale = !presentation.current && data.source === 'bff'
  const clusterEvidence = data.evidence.filter((item) => item.cluster === cluster.name || item.cluster === cluster.id)
  return <>
    <button className="back-button" onClick={close}>← All clusters</button>
    <PageTitle eyebrow={cluster.role} title={cluster.name} description={`${cluster.profile} · ${cluster.provider} · ${cluster.region}`} action={<div className="title-actions"><StatusBadge status={data.source === 'bff' && !clusterPresentation(cluster, data).current ? 'Unknown' : cluster.readiness}/><button className="shell-button" onClick={() => openShell(cluster)}><Icon name="terminal"/>Open Shell</button><button className="secondary-button">Propose change</button></div>}/>
    <FreshnessWarning data={data} freshness={cluster.freshness}/>
    {detailError && <div className="data-warning" role="alert"><Icon name="clock"/><div><strong>Cluster detail is unavailable</strong><span>{detailError.message} · {detailError.code}. The last valid summary remains visible.</span></div></div>}
    <div className="contract-strip"><div><span>Domain contract</span><strong>{cluster.contractVersion}</strong></div><div><span>Observed revision</span><strong>{cluster.revision}</strong></div><div><span>Console compatibility</span><StatusBadge status={cluster.compatibility}/></div></div>
    <div className="tabs" role="tablist">{['Overview', 'Lifecycle', 'Capabilities', 'Evidence', 'Changes'].map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>
    {tab === 'Overview' && <section className="detail-grid"><article className="panel"><div className="panel-title"><div><span className="eyebrow">{presentation.stale ? 'Last observed posture' : presentation.label}</span><h2>Lifecycle posture</h2></div><span className="live-label">{presentation.current && <span className="live-dot"/>}{presentation.stale ? 'Last observed' : presentation.current ? 'Observed' : presentation.label}</span></div>{cluster.lifecycle.length === 0 ? <EmptyState title="Detail is loading" description="The summary remains visible while the read-only detail projection is requested."/> : <div className="lifecycle">{cluster.lifecycle.map((step, index) => <div className="lifecycle-step" key={step.label}><div className={`step-dot ${step.state.toLowerCase()}`}>{step.state === 'Ready' ? '✓' : index + 1}</div><div><strong>{step.label}</strong><p>{stale ? `Last observed: ${observedText(step.detail, false)}` : observedText(step.detail, presentation.current)}</p></div><StatusBadge status={data.source === 'bff' && !presentation.current ? 'Unknown' : step.state}/></div>)}</div>}</article><article className="panel"><div className="panel-title"><div><span className="eyebrow">Evidence</span><h2>Readiness basis</h2></div><Icon name="evidence"/></div>{clusterEvidence.length === 0 ? <EmptyState title="No evidence reference" description="No readiness is inferred without a redaction-safe Evidence projection."/> : clusterEvidence.map((item) => <button className="evidence-card" key={item.id} onClick={() => openEvidence(item)}><div><span>{item.type}</span><EvidenceOutcome item={item} fixture={data.source !== 'bff'}/></div><strong>{item.title}</strong><p>{observedText(item.summary, evidencePresentation(item, data.source !== 'bff').current)}</p><small>{item.revision} · {new Date(item.observedAt).toLocaleString()}</small></button>)}</article></section>}
    {tab === 'Lifecycle' && <article className="panel wide-panel"><div className="panel-title"><div><span className="eyebrow">{stale ? 'Intent → last observation' : 'Intent → observation'}</span><h2>Lifecycle contract</h2></div></div><div className="timeline">{cluster.lifecycle.map((step) => <div key={step.label}><span className={`timeline-marker ${step.state.toLowerCase()}`}/><h3>{step.label}</h3><p>{stale ? `Last observed: ${observedText(step.detail, false)}` : observedText(step.detail, presentation.current)}</p><StatusBadge status={data.source === 'bff' && !presentation.current ? 'Unknown' : step.state}/></div>)}</div></article>}
    {tab === 'Capabilities' && (cluster.capabilityDetails ? <section className="table-panel">{cluster.capabilityDetails.map((capability) => <div className="table-row bff-capability-row" key={capability.id}><span><strong>{capability.name}</strong><small>{capability.id}</small></span><StatusBadge status={data.source === 'bff' && !capabilityPresentation(capability, cluster, data).current ? 'Unknown' : capability.readiness}/><EvidenceLink id={capability.evidenceId} evidence={data.evidence} onSelect={openEvidence}/></div>)}</section> : <CapabilityGrid capabilities={clusterCapabilities} data={data} openEvidence={openEvidence}/>)}
    {tab === 'Evidence' && (clusterEvidence.length === 0 ? <EmptyState title="No evidence references" description="The BFF returned no authorized, redaction-safe Evidence projections for this cluster."/> : <EvidenceList fixture={data.source !== 'bff'} evidence={clusterEvidence} onSelect={openEvidence}/>)}
    {tab === 'Changes' && <article className="empty-state panel"><Icon name="code" size={32}/><h2>No pending changes</h2><p>Changes remain proposals until review, authorization, and execution are independently recorded.</p><button className="secondary-button">Propose change</button></article>}
  </>
}

function Workloads({ claims, data, openEvidence }: { claims: WorkloadClaim[]; data: PlatformSnapshot; openEvidence: (e: EvidenceRef) => void }) {
  const [clusterFilter, setClusterFilter] = useState('all')
  const clusterNames = [...new Set([...data.clusters.map((cluster) => cluster.name), ...claims.map((claim) => claim.targetCluster)])]
  const counts = new Map<string, number>()
  for (const claim of claims) counts.set(claim.targetCluster, (counts.get(claim.targetCluster) ?? 0) + 1)
  const visibleClaims = clusterFilter === 'all' ? claims : claims.filter((claim) => claim.targetCluster === clusterFilter)

  return <><PageTitle eyebrow="Intent & observation" title="Workloads" description="Inspect observed workloads, their placement, readiness, and evidence."/>
    <div className="workload-toolbar">
      <label className="workload-filter"><span>Cluster</span><select aria-label="Filter workloads by cluster" value={clusterFilter} onChange={(event) => setClusterFilter(event.target.value)}>
        <option value="all">All clusters ({claims.length})</option>
        {clusterNames.map((name) => <option key={name} value={name}>{name} ({counts.get(name) ?? 0})</option>)}
      </select></label>
      <span className="workload-count" aria-live="polite">{visibleClaims.length} {visibleClaims.length === 1 ? 'workload' : 'workloads'}</span>
    </div>
    {visibleClaims.length === 0 && <EmptyState title={clusterFilter === 'all' ? 'No workloads observed' : `No workloads on ${clusterFilter}`} description={clusterFilter === 'all' ? 'Workloads appear when the configured source provides placement observations.' : 'No observed workload placements are available for this cluster yet.'}/>}
    <section className="claims-grid">{visibleClaims.map((claim) => {
      const observed = claim.kind === 'Observed Deployment'
      const cluster = data.clusters.find(item => item.id === claim.targetCluster || item.name === claim.targetCluster)
      const evidence = data.evidence.find(item => item.id === claim.evidenceId && (item.cluster === claim.targetCluster || item.cluster === cluster?.id || item.cluster === cluster?.name))
      const presentation = evidence && evidencePresentation({ ...evidence, freshness: conservativeVerdict(data.freshness, evidence.freshness) }, data.source !== 'bff')
      const replicas = observed ? evidence?.revision.match(/;replicas:([^;]+)/)?.[1] : undefined
      return <article className="claim-card" key={claim.id}>
        <div className="claim-head"><span className="claim-kind">{claim.kind}</span><StatusBadge status={data.source === 'bff' && !placementPresentation(claim, data).current ? 'Unknown' : claim.readiness}/></div>
        <h2>{claim.name}</h2><p>{claim.intent}</p>
        <div className="placement-flow"><div><span>Owner</span><strong>{claim.owner}</strong></div><Icon name="arrow"/><div><span>Placed on</span><strong>{claim.targetCluster}</strong></div></div>
        <div className="cap-tags">{claim.requiredCapabilities.map((item) => <span key={item}><Icon name="check" size={12}/>{item}</span>)}</div>
        <div className="decision"><Icon name="shield"/><div><span>{observed ? (presentation?.current || data.source !== 'bff' ? 'Available / desired replicas' : presentation?.stale ? 'Last observed' : 'Observation unavailable - readiness Unknown') : 'Placement decision'}</span><strong>{observed ? (data.source !== 'bff' || presentation?.current || presentation?.stale ? replicas ?? 'Unknown' : 'Unknown') : claim.decision}</strong></div></div>
        <EvidenceLink id={claim.evidenceId} evidence={data.evidence} onSelect={openEvidence}/>
      </article>
    })}</section></>
}

const agentFitsCluster = (agent: AgentDefinition, cluster: Cluster) => agent.requiredCapabilities.every((capability) => cluster.capabilities.includes(capability)) && cluster.compatibility === 'Supported'

function AgentDeployWizard({ agent, data, close }: { agent: AgentDefinition; data: PlatformSnapshot; close: () => void }) {
  const workerClusters = data.clusters.filter((cluster) => cluster.role === 'Workload cluster')
  const recommended = workerClusters.find((cluster) => cluster.name === agent.recommendedCluster && agentFitsCluster(agent, cluster))
  const [step, setStep] = useState(0)
  const [targetId, setTargetId] = useState(recommended?.id ?? '')
  const [enabledTools, setEnabledTools] = useState<string[]>(agent.tools.filter((tool) => tool.authority === 'Read only').map((tool) => tool.id))
  const [confirmed, setConfirmed] = useState(false)
  const target = workerClusters.find((cluster) => cluster.id === targetId)
  const requiredNames = agent.requiredCapabilities.map((id) => data.capabilities.find((capability) => capability.id === id)?.name ?? id)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const claim = `apiVersion: agents.openkubes.io/v1alpha1\nkind: AgentDeploymentClaim\nmetadata:\n  name: ${agent.id.replace('agent-', '')}\n  namespace: openkubes-agents\nspec:\n  agentRef:\n    name: ${agent.id}\n    version: ${agent.version}\n    digest: ${agent.artifactDigest}\n  clusterRef: ${target?.name ?? '<required>'}\n  tools:\n${enabledTools.map((tool) => `    - ${tool}`).join('\n') || '    []'}\n  authority: read-only\n  expiresAt: ${expiresAt}`
  const steps = ['Target', 'Permissions', 'Review', 'Evidence']

  return <div className="agent-deploy-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
    <section className="agent-deploy" role="dialog" aria-modal="true" aria-labelledby="deploy-agent-title">
      <header><div className="agent-deploy-title"><span className="agent-avatar"><Icon name="agents" size={24}/></span><div><span className="eyebrow">Agent Deployment Claim</span><h2 id="deploy-agent-title">Deploy {agent.name}</h2><p>{agent.version} · {agent.publisher} · {agent.artifactDigest}</p></div></div><span className="prototype-badge">Prototype · no-op</span><button className="icon-button" onClick={close} aria-label="Close agent deployment"><Icon name="x"/></button></header>
      <ol className="agent-steps">{steps.map((item, index) => <li className={index === step ? 'active' : index < step ? 'done' : ''} key={item}><span>{index < step ? '✓' : index + 1}</span><strong>{item}</strong></li>)}</ol>
      <div className="agent-deploy-body">
        {step === 0 && <><div className="deploy-section-title"><span className="eyebrow">Placement</span><h3>Choose a conformant Worker Cluster</h3><p>The Management Plane is intentionally excluded from agent placement.</p></div><div className="target-clusters">{workerClusters.map((cluster) => {
          const matching = agent.requiredCapabilities.filter((capability) => cluster.capabilities.includes(capability)).length
          const fit = agentFitsCluster(agent, cluster)
          return <label className={`${fit ? '' : 'disabled'} ${targetId === cluster.id ? 'selected' : ''}`} key={cluster.id}><input type="radio" name="target-cluster" value={cluster.id} checked={targetId === cluster.id} disabled={!fit} onChange={() => setTargetId(cluster.id)}/><span className="cluster-symbol small"><Icon name="cube" size={17}/></span><span><strong>{cluster.name}</strong><small>{cluster.profile} · {cluster.provider}</small></span><span className={`fit fit-${fit ? 'yes' : 'no'}`}>{fit ? '✓ Conformant' : `NO-GO · ${matching}/${agent.requiredCapabilities.length}`}<small>{fit ? `${matching}/${agent.requiredCapabilities.length} capabilities` : cluster.compatibility === 'Read only' ? 'Read-only compatibility' : 'Missing prerequisites'}</small></span></label>
        })}</div><div className="required-capabilities"><span>Required capabilities</span>{requiredNames.map((name) => <strong key={name}><Icon name="check" size={12}/>{name}</strong>)}</div></>}
        {step === 1 && <><div className="deploy-section-title"><span className="eyebrow">Least authority</span><h3>Review tools and permissions</h3><p>Read-only tools are selected by default. Tools that can propose change require a separate authority path.</p></div><div className="agent-tools">{agent.tools.map((tool) => <label key={tool.id}><input type="checkbox" checked={enabledTools.includes(tool.id)} onChange={(event) => setEnabledTools((current) => event.target.checked ? [...current, tool.id] : current.filter((item) => item !== tool.id))}/><span className={`tool-authority ${tool.authority === 'Read only' ? 'read' : 'approval'}`}><Icon name={tool.authority === 'Read only' ? 'check' : 'shield'} size={15}/></span><span><strong>{tool.label}</strong><small>{tool.id}</small></span><em>{tool.authority}</em></label>)}</div><div className="permissions-note"><Icon name="shield"/><div><strong>Runtime boundary</strong><p>The Agent receives no cluster-admin role, raw kubeconfig, or secret value. Server-side Policy and Authority remain normative.</p></div></div></>}
        {step === 2 && <><div className="deploy-section-title"><span className="eyebrow">Exact artifact review</span><h3>Review the generated AgentDeploymentClaim</h3><p>Placement, artifact digest, tools, and authority are bound into one review artifact.</p></div><div className="agent-review-grid"><div><span>Agent</span><strong>{agent.name} · {agent.version}</strong></div><div><span>Target</span><strong>{target?.name}</strong></div><div><span>Tools</span><strong>{enabledTools.length} selected</strong></div><div><span>Resource profile</span><strong>{agent.resourceProfile}</strong></div></div><pre className="contract-preview agent-claim"><code>{claim}</code></pre><div className="no-go"><Icon name="shield"/><div><strong>NO-GO conditions</strong><p>Unsigned artifact, missing capability, incompatible Contract, expanded authority, stale Evidence, or changed payload digest prevents deployment.</p></div></div><label className="confirm-box agent-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}/><span>I reviewed this exact AgentDeploymentClaim and its tool authority.</span></label></>}
        {step === 3 && <div className="agent-evidence-success"><span className="agent-success-icon"><Icon name="check" size={31}/></span><span className="eyebrow">Prototype Evidence</span><h3>Deployment journey validated</h3><p>No Agent, namespace, credential, workload, or backend resource was created. A production reconciliation would now expose correlated Conditions and Evidence.</p><dl><div><dt>Agent</dt><dd>{agent.name} · {agent.version}</dd></div><div><dt>Placement</dt><dd>{target?.name} / openkubes-agents</dd></div><div><dt>Authority</dt><dd>{enabledTools.join(', ') || 'none'}</dd></div><div><dt>Evidence</dt><dd>agent-deploy/{agent.id}/prototype-01</dd></div><div><dt>Outcome</dt><dd><StatusBadge status="Ready"/> Simulated only</dd></div></dl><button className="secondary-button" onClick={close}>Return to AI Agents</button></div>}
      </div>
      {step < 3 && <footer className="agent-deploy-actions"><button className="secondary-button" onClick={() => step === 0 ? close() : setStep(step - 1)}>{step === 0 ? 'Cancel' : 'Back'}</button><span><Icon name="shield" size={13}/>No live deployment</span><button className="primary-button" disabled={(step === 0 && !target) || (step === 2 && !confirmed)} onClick={() => setStep(step + 1)}>{step === 0 ? 'Review permissions' : step === 1 ? 'Generate claim' : 'Simulate deployment'}<Icon name="arrow" size={15}/></button></footer>}
    </section>
  </div>
}

function Agents({ data, openEvidence }: { data: PlatformSnapshot; openEvidence: (e: EvidenceRef) => void }) {
  const [category, setCategory] = useState<'All' | AgentDefinition['category']>('All')
  const [deployAgent, setDeployAgent] = useState<AgentDefinition>()
  const agents = category === 'All' ? data.agents : data.agents.filter((agent) => agent.category === category)
  const capabilityName = (id: string) => data.capabilities.find((capability) => capability.id === id)?.name ?? id
  return <>
    <PageTitle eyebrow="Agentic workloads" title="AI Agents" description="Discover verified Agents, inspect their authority, and place them on conformant Worker Clusters." action={<span className="agent-contract"><Icon name="shield" size={15}/><span><small>Agent Contract</small><strong>agents.openkubes.io/v1alpha1</strong></span></span>}/>
    <section className="agent-metrics"><Metric label="Catalog" value={data.agents.length} note="Curated Agent definitions" tone="blue"/><Metric label="Verified artifacts" value={data.agents.filter((agent) => agent.verified).length} note="Signature and provenance visible" tone="green"/><Metric label="Deployments" value={data.agentDeployments.length} note="Across Worker Clusters" tone="orange"/></section>
    <div className="agent-filter"><span>Catalog</span>{(['All', 'Platform Operations', 'Developer Experience', 'Evidence & Governance'] as const).map((item) => <button className={category === item ? 'active' : ''} onClick={() => setCategory(item)} key={item}>{item}</button>)}</div>
    <section className="agent-grid">{agents.map((agent) => <article className="agent-card" key={agent.id}><div className="agent-card-head"><span className="agent-avatar"><Icon name="agents" size={21}/></span><span className={`publisher-badge ${agent.demoOnly ? 'demo' : agent.verified ? 'verified' : 'community'}`}><Icon name={agent.demoOnly ? 'clock' : agent.verified ? 'check' : 'clock'} size={11}/>{agent.demoOnly ? 'Demo Preview' : agent.verified ? 'Verified' : 'Community'}</span></div><span className="agent-category">{agent.category}</span><h2>{agent.name}</h2><p>{agent.description}</p><div className="agent-version"><span><small>Version</small><strong>{agent.version}</strong></span><span><small>Publisher</small><strong>{agent.publisher}</strong></span><span><small>Resources</small><strong>{agent.resourceProfile}</strong></span></div><div className="agent-requires"><span>Requires</span><div>{agent.requiredCapabilities.map((id) => <strong key={id}><Icon name="capabilities" size={11}/>{capabilityName(id)}</strong>)}</div></div><div className="agent-placement"><span><Icon name="cube" size={14}/>Recommended</span><strong>{agent.recommendedCluster}</strong></div><footer><span>{data.source === 'bff' ? 'Catalog definition' : <>{agent.deployments} deployment{agent.deployments === 1 ? '' : 's'}</>}</span><button className="primary-button" disabled={!agent.verified || agent.demoOnly} onClick={() => setDeployAgent(agent)}>{agent.demoOnly ? 'Preview only' : agent.verified ? 'Deploy Agent' : 'Review required'}<Icon name="arrow" size={14}/></button></footer></article>)}</section>
    <section className="section-block"><div className="section-heading"><div><span className="eyebrow">Runtime instances</span><h2>Agent deployments</h2></div><span className="count-badge">{data.agentDeployments.length}</span></div><div className="agent-deployments">{data.agentDeployments.map((deployment) => <article key={deployment.id}><span className="agent-avatar small"><Icon name="agents" size={17}/></span><span><strong>{deployment.name}</strong><small>{deployment.agentName} · {deployment.version}</small></span><span><small>Worker Cluster</small><strong>{deployment.cluster}</strong></span><span><small>Namespace</small><strong>{deployment.namespace}</strong></span><span><small>Authority</small><strong>{deployment.authority}</strong></span><StatusBadge status={deployment.readiness}/><EvidenceLink id={deployment.evidenceId} evidence={data.evidence} onSelect={openEvidence}/></article>)}</div></section>
    {deployAgent && <AgentDeployWizard agent={deployAgent} data={data} close={() => setDeployAgent(undefined)}/>}
  </>
}

function CapabilityGrid({ capabilities, data, openEvidence }: { capabilities: Capability[]; data: PlatformSnapshot; openEvidence: (e: EvidenceRef) => void }) {
  return <section className="capability-grid">{capabilities.map((capability) => <article className="capability-card" key={capability.id}><div className="capability-head"><span className="capability-icon"><Icon name="capabilities"/></span><StatusBadge status={capability.readiness}/></div><h2>{capability.name}</h2><p>{capability.description}</p><dl><div><dt>Implementation</dt><dd>{capability.implementation}</dd></div><div><dt>Contract</dt><dd>{capability.contractVersion}</dd></div><div><dt>Cluster coverage</dt><dd>{capability.clusters} clusters</dd></div></dl><div className="coverage"><span style={{ width: `${capability.coverage}%` }}/></div><footer><span>{capability.coverage}% profile coverage</span><EvidenceLink id={capability.evidenceId} evidence={data.evidence} onSelect={openEvidence}/></footer></article>)}</section>
}

function Capabilities({ data, openEvidence }: { data: PlatformSnapshot; openEvidence: (e: EvidenceRef) => void }) {
  const demoPreview = data.source === 'bff' && data.capabilities.length === 0
  const capabilities = demoPreview ? platformFixture.capabilities : data.capabilities
  return <>
    <PageTitle eyebrow="Global catalog" title="Capabilities" description="Contracts first. Implementations remain replaceable and provider-neutral." action={demoPreview ? <span className="prototype-badge">Demo catalog</span> : undefined}/>
    {demoPreview && <aside className="capability-preview-note" role="note"><strong>Illustrative capability examples</strong><span>These seven entries are demo fixtures, not observations from ok-shared. Observed capability totals and cluster readiness remain unchanged.</span></aside>}
    {capabilities.length > 0
      ? <CapabilityGrid capabilities={capabilities} data={data} openEvidence={openEvidence}/>
      : <EmptyState title="No capabilities observed" description="The Console BFF returned no capability records. No capability readiness is inferred."/>}
  </>
}

function EvidenceList({ evidence, onSelect, fixture = false }: { evidence: EvidenceRef[]; onSelect: (e: EvidenceRef) => void; fixture?: boolean }) {
  return <section className="evidence-list">{evidence.map((item) => <button className="evidence-row" onClick={() => onSelect(item)} key={item.id}><span className={`evidence-type type-${item.type.toLowerCase()}`}><Icon name={item.type === 'Authorization' ? 'shield' : 'evidence'}/>{item.type}</span><span><strong>{item.title}</strong><small>{item.cluster} · {item.contract}</small></span><EvidenceOutcome item={item} fixture={fixture}/><span className="revision">{item.revision}</span><span><strong>{new Date(item.observedAt).toLocaleDateString()}</strong><small>{new Date(item.observedAt).toLocaleTimeString()}</small></span><Icon name="chevron"/></button>)}</section>
}

function Evidence({ data, openEvidence }: { data: PlatformSnapshot; openEvidence: (e: EvidenceRef) => void }) {
  const [filter, setFilter] = useState<'All' | EvidenceRef['type']>('All')
  const items = filter === 'All' ? data.evidence : data.evidence.filter((item) => item.type === filter)
  return <><PageTitle eyebrow="Trust & provenance" title="Evidence & Audit" description="Freshness-bound observations, immutable outcomes, and authority decisions remain distinct."/>
    <FreshnessWarning data={data} freshness={data.evidence.some(item => item.freshness === 'Stale') ? 'Stale' : data.evidence.some(item => !item.immutable && item.freshness !== 'Current') ? 'Unknown' : data.freshness}/>
    <section className="framework-preview" aria-labelledby="framework-preview-title">
      <div className="framework-preview-heading"><div><span className="eyebrow">Roadmap preview</span><h2 id="framework-preview-title">Framework views</h2></div><span>Scope in definition</span></div>
      <div className="framework-preview-grid">
        <article className="framework-preview-card">
          <div className="framework-preview-card-head"><span className="framework-preview-icon"><Icon name="shield"/></span><span className="planned-badge">Planned</span></div>
          <h3>DORA Evidence View</h3>
          <p>A planned view for evidence across ICT assets and functions, incidents and resilience tests, and ICT third-party services.</p>
          <div className="framework-preview-topics"><span>ICT assets & functions</span><span>Incidents & tests</span><span>Third-party services</span></div>
          <small>Preview only · No DORA assessment is available yet.</small>
        </article>
        <article className="framework-preview-card">
          <div className="framework-preview-card-head"><span className="framework-preview-icon"><Icon name="shield"/></span><span className="planned-badge">Planned</span></div>
          <h3>KRITIS Evidence View</h3>
          <p>A planned view for operator and sector-specific evidence mapping, findings, and supporting records.</p>
          <div className="framework-preview-topics"><span>Operator profile</span><span>Sector mapping</span><span>Findings & evidence</span></div>
          <small>Preview only · No KRITIS assessment is available yet.</small>
        </article>
      </div>
    </section>
    <div className="evidence-explainer"><div><span className="legend observation"/><strong>Observation</strong><small>Freshness-bound observation</small></div><div><span className="legend transition"/><strong>Transition</strong><small>Immutable historical outcome</small></div><div><span className="legend authorization"/><strong>Authorization</strong><small>Explicit authority decision</small></div></div><div className="filter-bar">{(['All', 'Observation', 'Transition', 'Authorization'] as const).map((item) => <button className={`filter-chip ${filter === item ? 'active' : ''}`} onClick={() => setFilter(item)} key={item}>{item}</button>)}</div><EvidenceList fixture={data.source !== 'bff'} evidence={items} onSelect={openEvidence}/></>
}

const createSteps = ['Draft', 'Review', 'Authorize', 'Execute', 'Evidence'] as const

const createClusterProviderGroups = [
  {
    label: 'Sovereign & self-managed · demo catalog',
    providers: ['Bare Metal Infra', 'KubeVirt Workers', 'OpenStack', 'VMware vSphere', 'Proxmox', 'STACKIT', 'Hetzner', 'OVHcloud', 'YORIZON'],
  },
  {
    label: 'AI factory · experimental demo catalog',
    providers: ['NVIDIA Kubernetes Engine (NVKE)'],
  },
  {
    label: 'Public cloud · demo catalog',
    providers: ['AWS', 'GCP', 'Azure'],
  },
] as const

const providerIdentifier = (provider: string) => provider === 'NVIDIA Kubernetes Engine (NVKE)' ? 'nvidia-nvke' : provider.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function CreateCluster({ onSessionEnded }: { onSessionEnded: () => void }) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('ok-edge-berlin')
  const [provider, setProvider] = useState('Bare Metal Infra')
  const isNvke = provider === 'NVIDIA Kubernetes Engine (NVKE)'
  const [profile, setProfile] = useState('Constrained edge')
  const [confirmed, setConfirmed] = useState(false)
  const [dryRunState, setDryRunState] = useState<'idle' | 'running' | 'ready' | 'error'>('idle')
  const [dryRunResult, setDryRunResult] = useState<{ contractRevision?: string; contractIdentity?: string; mutationAllowed?: boolean } | null>(null)
  const [dryRunError, setDryRunError] = useState<string | null>(null)
  const contract = `apiVersion: platform.openkubes.io/v1alpha1\nkind: OpenKubesCluster\nmetadata:\n  name: ${name || 'cluster-name'}\nspec:\n  role: workload\n  implementationProfile:\n    provider: ${providerIdentifier(provider)}\n    profile: ${profile.toLowerCase().replace(' ', '-')}\n  capabilities:\n    required:\n      - observability\n      - persistent-storage`
  const runDryRun = async () => {
    setDryRunState('running'); setDryRunError(null)
    const payload = { apiVersion: 'platform.openkubes.io/v1alpha1', kind: 'OpenKubesCluster', metadata: { name: name || 'cluster-name', namespace: 'default' }, spec: { role: 'workload', implementationProfile: { provider: providerIdentifier(provider), profile: profile.toLowerCase().replace(' ', '-') }, capabilities: { required: ['observability', 'persistent-storage'] } } }
    try {
      const response = await fetch('/api/console/v0/operations/create-cluster/dry-run', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ contract: payload }) })
      if (response.status === 401) { onSessionEnded(); return }
      const body = await response.json() as { data?: typeof dryRunResult; error?: { message?: string } }
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? 'The dry-run could not be completed.')
      setDryRunResult(body.data); setDryRunState('ready'); setStep(3)
    } catch (error) { setDryRunState('error'); setDryRunError(error instanceof Error ? error.message : 'The dry-run could not be completed.') }
  }
  const next = () => setStep((current) => Math.min(current + 1, createSteps.length - 1))
  return <>
    <PageTitle eyebrow="Prototype journey" title="Create Cluster" description="A safe preview of the complete contract-governed flow. No backend mutation is possible." action={<span className="prototype-badge">Prototype · no-op</span>}/>
    <ol className="stepper">{createSteps.map((item, index) => <li className={index === step ? 'active' : index < step ? 'done' : ''} key={item}><span>{index < step ? '✓' : index + 1}</span><strong>{item}</strong></li>)}</ol>
    <div className="create-layout">
      <section className="panel create-main">
        {step === 0 && <><div className="panel-title"><div><span className="eyebrow">Step 1</span><h2>Declare cluster intent</h2></div></div><div className="form-grid"><label><span>Cluster name</span><input value={name} onChange={(event) => setName(event.target.value)}/><small>Lowercase DNS-compatible identity</small></label><label><span>Infrastructure provider</span><select aria-label="Infrastructure provider" value={provider} onChange={(event) => setProvider(event.target.value)}>{createClusterProviderGroups.map((group) => <optgroup label={group.label} key={group.label}>{group.providers.map((item) => <option key={item}>{item}</option>)}</optgroup>)}</select><small>Illustrative CAPI provider catalog · selection does not provision infrastructure</small></label><label><span>Implementation profile</span><select value={profile} onChange={(event) => setProfile(event.target.value)}><option>Constrained edge</option><option>General purpose</option><option>AI accelerated</option><option>Shared services</option></select></label><label><span>Region / placement</span><input defaultValue="ber-edge-1"/></label></div><fieldset><legend>Required capabilities</legend><div className="check-grid"><label><input type="checkbox" defaultChecked/>Observability</label><label><input type="checkbox" defaultChecked/>Persistent Storage</label><label><input type="checkbox"/>Ingress</label><label><input type="checkbox"/>Artifact Registry</label></div></fieldset>{isNvke && <div className="prototype-warning"><strong>NVIDIA Kubernetes Engine (NVKE) · experimental demo.</strong> NVKE is an external lifecycle management engine, not a generic CAPI infrastructure provider. A registered NVKE management plane, site and supported node releases would be required for real provisioning. No NVKE connection or GPU infrastructure is configured here.</div>}</>}
        {step === 1 && <><div className="panel-title"><div><span className="eyebrow">Step 2</span><h2>Review generated contract</h2></div><span className="digest">sha256:preview…7a21</span></div><div className="review-summary"><div><span>Requested identity</span><strong>{name}</strong></div><div><span>Profile</span><strong>{profile}</strong></div><div><span>Provider</span><strong>{provider}</strong></div></div><pre className="contract-preview"><code>{contract}</code></pre><div className="no-go"><Icon name="shield"/><div><strong>NO-GO checks</strong><p>Execution remains unavailable if identity, placement, capability prerequisites, policy, or evidence freshness cannot be proven.</p></div></div></>}
        {step === 2 && <><div className="authority-card"><div className="authority-icon"><Icon name="shield" size={32}/></div><span className="eyebrow">Step 3 · Authority boundary</span><h2>Authorize this exact review artifact</h2><p>This prototype illustrates a single-use grant bound to the reviewed payload digest. The browser is never the security boundary.</p><dl><div><dt>Operation</dt><dd>CreateCluster</dd></div><div><dt>Payload digest</dt><dd>sha256:preview…7a21</dd></div><div><dt>Grant</dt><dd>Single use · 10 minutes</dd></div></dl><label className="confirm-box"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}/><span>I confirm that I reviewed the exact contract above.</span></label></div></>}
        {step === 3 && <><div className="execution-preview"><span className="pulse-ring"><Icon name="code" size={28}/></span><span className="eyebrow">Step 4</span><h2>Dry-run plan</h2><p>The Console sent a bounded, non-mutating CreateCluster dry-run to the OK-147 runner.</p><div className="boundary-stack"><div className="done"><Icon name="check"/><span><strong>Runner reached</strong><small>{dryRunResult?.contractIdentity ?? 'CreateCluster'}</small></span></div><div className="done"><Icon name="check"/><span><strong>Mutation disabled</strong><small>mutationAllowed: {String(dryRunResult?.mutationAllowed ?? false)}</small></span></div><div><Icon name="evidence"/><span><strong>Contract revision</strong><small>{dryRunResult?.contractRevision ?? 'not returned'}</small></span></div></div></div></>}
        {step === 4 && <><div className="success-state"><span><Icon name="check" size={32}/></span><div className="eyebrow">Step 5</div><h2>Evidence shape validated</h2><p>The prototype journey is complete. A production execution would create immutable transition evidence and current observations, correlated to this request.</p><div className="mock-receipt"><div><span>Result</span><StatusBadge status="Ready"/></div><div><span>Correlation</span><strong>create/{name}/generation-1</strong></div><div><span>Receipt</span><strong>prototype-only · not authoritative</strong></div></div></div></>}
        {dryRunError && <div className="prototype-warning"><strong>Dry-run failed.</strong> {dryRunError}</div>}<footer className="form-actions"><button className="secondary-button" disabled={step === 0 || dryRunState === 'running'} onClick={() => setStep(step - 1)}>Back</button>{step < 4 ? <button className="primary-button" disabled={(step === 2 && !confirmed) || dryRunState === 'running'} onClick={step === 2 ? runDryRun : next}>{dryRunState === 'running' ? 'Running dry-run…' : step === 0 ? 'Generate contract' : step === 1 ? 'Continue to authorization' : step === 2 ? 'Run safe dry-run' : 'Continue'}<Icon name="arrow"/></button> : <button className="primary-button" onClick={() => { setStep(0); setConfirmed(false); setDryRunState('idle'); setDryRunResult(null) }}>Start another draft</button>}</footer>
      </section>
      <aside className="panel guardrail-panel"><span className="eyebrow">Guardrails</span><h2>What this UI guarantees</h2><ul><li><Icon name="check"/>Intent stays distinct from state.</li><li><Icon name="check"/>Review precedes authorization.</li><li><Icon name="check"/>Grant binds to exact payload.</li><li><Icon name="check"/>Evidence does not invent readiness.</li><li><Icon name="check"/>Unknown compatibility fails closed.</li></ul><div className="contract-meta"><span>Presentation mapping</span><strong>console.openkubes.io/v0alpha1</strong><span>Supported domain contract</span><strong>platform.openkubes.io/v1alpha1</strong></div></aside>
    </div>
  </>
}

const registrationSteps = ['Connect', 'Discover', 'Scope', 'Review', 'Authorize', 'Evidence'] as const

function LifecycleUnavailable({ action }: { action: 'create' | 'register' }) {
  const { policy } = useDeploymentPolicy()
  return <section className="panel lifecycle-unavailable" role="note" aria-label="Cluster lifecycle not available">
    <span className="eyebrow">Not available in this installation</span>
    <h2>{action === 'register' ? 'Registering clusters' : 'Creating clusters'} is not part of this installation</h2>
    <p>{policy === 'fixture-read-only' ? 'This installation runs under the fixture-read-only deployment policy. It shows simulated fixture data and cannot create, register, or contact any cluster; the server refuses such requests.' : 'The deployment policy of this installation could not be confirmed, so cluster lifecycle actions stay unavailable.'}</p>
  </section>
}

function RegisterCluster() {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('external-production-eu')
  const [externalEngine, setExternalEngine] = useState('Generic Kubernetes')
  const isNvkeRegistration = externalEngine === 'NVIDIA Kubernetes Engine (NVKE)'
  const [environment, setEnvironment] = useState<ExternalClusterRegistrationDraft['environment']>('Production')
  const [connection, setConnection] = useState<ExternalClusterConnection>('Agent')
  const [managementMode, setManagementMode] = useState<ExternalClusterManagementMode>('ObserveOnly')
  const [confirmed, setConfirmed] = useState(false)
  const draft: ExternalClusterRegistrationDraft = {
    apiVersion: 'clusters.openkubes.io/v1alpha1',
    kind: 'ExternalClusterRegistration',
    clusterName: name || 'external-cluster-name',
    environment,
    ownership: 'External',
    connection,
    managementMode,
  }
  const managementModeLabel = managementMode === 'ObserveOnly' ? 'Observe only' : managementMode === 'ManagedOperations' ? 'Managed operations' : 'Full adoption'
  const contract = `apiVersion: ${draft.apiVersion}\nkind: ${draft.kind}\nmetadata:\n  name: ${draft.clusterName}\nspec:\n  ownership: ${draft.ownership}\n  environment: ${draft.environment}\n  connection:\n    type: ${draft.connection}\n    direction: ${draft.connection === 'Agent' ? 'Outbound' : 'Federated'}\n  managementMode: ${draft.managementMode}\n  identity:\n    joinKey: ${draft.clusterName}${isNvkeRegistration ? '\n  externalManagementEngine: nvidia-nvke # demo-only extension, not a normative API field' : ''}`
  const next = () => setStep((current) => Math.min(current + 1, registrationSteps.length - 1))
  const reset = () => { setStep(0); setConfirmed(false); setManagementMode('ObserveOnly') }
  return <>
    <PageTitle eyebrow="External fleet" title="Register Existing Cluster" description="Discover an existing Kubernetes cluster without silently taking lifecycle ownership." action={<span className="prototype-badge">Prototype · no connection</span>}/>
    <ol className="stepper registration-stepper">{registrationSteps.map((item, index) => <li className={index === step ? 'active' : index < step ? 'done' : ''} key={item}><span>{index < step ? '✓' : index + 1}</span><strong>{item}</strong></li>)}</ol>
    <div className="create-layout registration-layout">
      <section className="panel create-main registration-main">
        {step === 0 && <>
          <div className="panel-title"><div><span className="eyebrow">Step 1 · Connection intent</span><h2>Identify the existing cluster</h2></div><span className="ownership-badge">External ownership</span></div>
          <div className="form-grid"><label><span>Cluster identity</span><input value={name} onChange={(event) => setName(event.target.value)}/><small>Stable DNS-compatible join key from ADR-013</small></label><label><span>Environment</span><select value={environment} onChange={(event) => setEnvironment(event.target.value as ExternalClusterRegistrationDraft['environment'])}><option>Development</option><option>Staging</option><option>Production</option></select><small>Used for Policy and Evidence context</small></label><label><span>External management engine</span><select aria-label="External management engine" value={externalEngine} onChange={(event) => setExternalEngine(event.target.value)}><option>Generic Kubernetes</option><option>NVIDIA Kubernetes Engine (NVKE)</option></select><small>Demo metadata only · does not connect to the engine</small></label></div>
          {isNvkeRegistration && <div className="prototype-warning"><strong>NVKE-managed cluster · simulated registration.</strong> NVIDIA retains lifecycle ownership. OpenKubes defaults to observe-only; this preview does not contact NVKE or verify GPU capabilities.</div>}
          <fieldset className="connection-fieldset"><legend>Connection method</legend><div className="connection-options">
            <label className={connection === 'Agent' ? 'selected' : ''}><input type="radio" name="connection" checked={connection === 'Agent'} onChange={() => setConnection('Agent')}/><span className="connection-icon"><Icon name="register"/></span><span><strong>Outbound Connector</strong><small>Recommended · mTLS · no inbound firewall rule</small></span><em>Recommended</em></label>
            <label className={connection === 'OIDC' ? 'selected' : ''}><input type="radio" name="connection" checked={connection === 'OIDC'} onChange={() => setConnection('OIDC')}/><span className="connection-icon"><Icon name="shield"/></span><span><strong>OIDC Federation</strong><small>Short-lived identity through an existing trust provider</small></span><em>Advanced</em></label>
            <label className="disabled"><input type="radio" name="connection" disabled/><span className="connection-icon"><Icon name="code"/></span><span><strong>Upload kubeconfig</strong><small>Long-lived credentials are not accepted in the browser</small></span><em>Unavailable</em></label>
          </div></fieldset>
        </>}
        {step === 1 && <>
          <div className="panel-title"><div><span className="eyebrow">Step 2 · Read-only discovery</span><h2>Review discovered cluster facts</h2></div><span className="fixture-label">Simulated fixture</span></div>
          <div className="discovery-hero"><span className="cluster-symbol"><Icon name="cube" size={21}/></span><div><strong>{name}</strong><small>{isNvkeRegistration ? 'NVKE-managed Kubernetes cluster · simulated' : 'Existing upstream Kubernetes cluster'}</small></div><StatusBadge status="Ready"/></div>
          <div className="discovery-grid"><div><span>Kubernetes</span><strong>v1.31.8</strong><small>Supported presentation</small></div><div><span>Nodes</span><strong>5</strong><small>3 control plane · 2 worker</small></div><div><span>Distribution</span><strong>{isNvkeRegistration ? 'NVKE-managed' : 'Upstream'}</strong><small>{isNvkeRegistration ? 'Unverified demo metadata' : 'Provider neutral'}</small></div><div><span>Endpoint</span><strong>Reachable</strong><small>Read-only probe</small></div></div>
          <div className="capability-assessment"><div className="panel-title"><div><span className="eyebrow">Capability assessment</span><h3>Observed, not installed</h3></div></div><div><span><Icon name="check"/>StorageClass API</span><strong>Observed</strong></div><div><span><Icon name="check"/>Ingress API</span><strong>Observed</strong></div><div><span><Icon name="clock"/>OpenKubes Evidence</span><strong>Not enrolled</strong></div></div>
          <div className="prototype-warning"><strong>No cluster was contacted.</strong> Discovery values are deterministic prototype fixtures and do not establish readiness.</div>
        </>}
        {step === 2 && <>
          <div className="panel-title"><div><span className="eyebrow">Step 3 · Least authority</span><h2>Choose the management scope</h2></div></div>
          <p className="section-intro">Registration does not transfer lifecycle ownership. Additional authority must be explicit, reviewable, and revocable.</p>
          <div className="scope-options">
            <label className={managementMode === 'ObserveOnly' ? 'selected' : ''}><input type="radio" name="management-mode" checked={managementMode === 'ObserveOnly'} onChange={() => setManagementMode('ObserveOnly')}/><span className="scope-icon read"><Icon name="evidence"/></span><span><strong>Observe only</strong><small>Inventory, Conditions, Capabilities, and redaction-safe Evidence</small></span><em>Recommended</em></label>
            <label className={managementMode === 'ManagedOperations' ? 'selected' : ''}><input type="radio" name="management-mode" checked={managementMode === 'ManagedOperations'} onChange={() => setManagementMode('ManagedOperations')}/><span className="scope-icon approval"><Icon name="shield"/></span><span><strong>Managed operations</strong><small>Approved Day-2 operations through Review → Authorization → Execution</small></span><em>Explicit grants</em></label>
            <label className="disabled"><input type="radio" name="management-mode" disabled/><span className="scope-icon blocked"><Icon name="x"/></span><span><strong>Full adoption</strong><small>Requires a separate lifecycle ownership and migration Contract</small></span><em>NO-GO</em></label>
          </div>
          <div className="permissions-note"><Icon name="shield"/><div><strong>Credential boundary</strong><p>No raw kubeconfig, cluster-admin role, or secret value enters the browser. Connection identity remains short-lived and independently revocable.</p></div></div>
        </>}
        {step === 3 && <>
          <div className="panel-title"><div><span className="eyebrow">Step 4 · Exact artifact review</span><h2>Review ExternalClusterRegistration</h2></div><span className="digest">sha256:register…31d8</span></div>
          <div className="review-summary"><div><span>Cluster</span><strong>{name}</strong></div><div><span>Ownership</span><strong>External</strong></div><div><span>Management</span><strong>{managementModeLabel}</strong></div></div>
          <pre className="contract-preview registration-contract"><code>{contract}</code></pre>
          <div className="no-go"><Icon name="shield"/><div><strong>NO-GO checks</strong><p>Unknown identity, unsupported Kubernetes version, stale discovery, expanded authority, changed payload digest, or missing server-side Policy prevents registration.</p></div></div>
        </>}
        {step === 4 && <>
          <div className="authority-card"><div className="authority-icon"><Icon name="shield" size={32}/></div><span className="eyebrow">Step 5 · Authority boundary</span><h2>Authorize this exact registration artifact</h2><p>A production Console would bind a single-use grant to the reviewed payload digest. Registration writes only to the OpenKubes management plane and does not mutate the external cluster.</p><dl><div><dt>Operation</dt><dd>RegisterExternalCluster</dd></div><div><dt>Payload digest</dt><dd>sha256:register…31d8</dd></div><div><dt>Initial authority</dt><dd>{managementModeLabel}</dd></div></dl><label className="confirm-box"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}/><span>I reviewed this exact ExternalClusterRegistration and its authority scope.</span></label><div className="prototype-warning"><strong>No request will be sent.</strong> This prototype creates no credential, connector, Secret, ProviderConfig, or backend resource.</div></div>
        </>}
        {step === 5 && <>
          <div className="success-state registration-success"><span><Icon name="check" size={32}/></span><div className="eyebrow">Step 6 · Prototype Evidence</div><h2>Registration journey validated</h2><p>The external cluster remains externally owned. A production reconciliation would now expose current Conditions and correlated Evidence without inventing readiness.</p><div className="mock-receipt"><div><span>Cluster</span><strong>{name}</strong></div><div><span>Ownership</span><strong>External · unchanged</strong></div><div><span>Management</span><strong>{managementModeLabel}</strong></div><div><span>Correlation</span><strong>register/{name}/prototype-01</strong></div><div><span>Result</span><strong>Simulated only · no resource created</strong></div></div></div>
        </>}
        <footer className="form-actions"><button className="secondary-button" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>{step < 5 ? <button className="primary-button" disabled={(step === 0 && !name.trim()) || (step === 4 && !confirmed)} onClick={next}>{step === 0 ? 'Run safe discovery' : step === 1 ? 'Review management scope' : step === 2 ? 'Generate registration' : step === 3 ? 'Continue to authorization' : 'Authorize prototype'}<Icon name="arrow"/></button> : <button className="primary-button" onClick={reset}>Register another cluster</button>}</footer>
      </section>
      <aside className="panel guardrail-panel registration-guardrails"><span className="eyebrow">External cluster contract</span><h2>Ownership stays explicit</h2><ul><li><Icon name="check"/>Registration is not lifecycle adoption.</li><li><Icon name="check"/>Observe-only is the safe default.</li><li><Icon name="check"/>No browser kubeconfig upload.</li><li><Icon name="check"/>Authority remains revocable.</li><li><Icon name="check"/>Discovery never implies readiness.</li></ul><div className="contract-meta"><span>Presentation mapping</span><strong>console.openkubes.io/v0alpha1</strong><span>Candidate registration shape</span><strong>clusters.openkubes.io/v1alpha1</strong><span>Normative registration basis</span><strong>ADR-Platform-013</strong></div></aside>
    </div>
  </>
}

type ShellEntry = {
  kind: 'system' | 'command' | 'output' | 'blocked' | 'ai' | 'proposal'
  content: string
  generation?: number
  observedAt?: string
  historical?: boolean
}

const MUTATING_COMMAND = /\b(apply|create|delete|edit|patch|replace|scale|cordon|drain|uncordon|exec|rollout\s+restart|set\s+image)\b/i

function simulatedShellResponse(command: string, cluster: Cluster, source: PlatformSnapshot['source'], presentation?: ReturnType<typeof observationPresentation>): ShellEntry[] {
  const readiness = presentation && !presentation.current ? `Unknown (last observed ${cluster.readiness})` : `${cluster.readiness}${presentation ? ` (${presentation.label})` : ''}`
  const normalized = command.trim().toLowerCase()
  if (MUTATING_COMMAND.test(normalized)) {
    return [{ kind: 'blocked', content: 'BLOCKED · This read-only prototype cannot invoke a mutating operation. A production request would enter Review → Authorization → Execution.' }]
  }
  if (normalized.includes('why') || normalized.includes('explain') || normalized.includes('pending')) {
    const pending = cluster.lifecycle.filter((item) => item.state !== 'Ready')
    const explanation = cluster.lifecycle.length === 0
      ? `This shell session holds readiness ${readiness} for ${cluster.name}. This shell session holds no lifecycle detail for ${cluster.name}.`
      : pending.length > 0
      ? `This shell session holds readiness ${readiness} for ${cluster.name}.\n${pending.map((item) => `${item.label}: ${item.state} — ${item.detail}`).join('\n')}`
      : cluster.readiness === 'Ready'
        ? `This shell session holds readiness ${readiness} and ${cluster.lifecycle.length} lifecycle stage(s), all reporting Ready.`
        : `This shell session holds readiness ${readiness} for ${cluster.name}. Its ${cluster.lifecycle.length} lifecycle stage(s) all report Ready; stages do not establish overall readiness.`
    return [
      { kind: 'ai', content: explanation },
      { kind: 'proposal', content: `Suggested read-only command · kubectl get clusterconditions -o wide` },
    ]
  }
  if (normalized === 'help') {
    return [{ kind: 'output', content: 'Allowed examples:\n  kubectl get clusterconditions -o wide\n  ok evidence explain\n  why is this cluster pending?' }]
  }
  if (normalized.includes('get nodes')) {
    return [{ kind: 'blocked', content: 'UNAVAILABLE · Node listings are not available from the observed-state contract.' }]
  }
  if (normalized.includes('get namespaces')) {
    return [{ kind: 'blocked', content: 'UNAVAILABLE · Namespace listings are not available from the observed-state contract.' }]
  }
  if (normalized.includes('clusterconditions')) {
    if (cluster.lifecycle.length === 0) {
      return [{ kind: 'blocked', content: `UNAVAILABLE · This shell session holds no lifecycle detail for ${cluster.name}.` }]
    }
    return [{ kind: 'output', content: `This shell session holds the following lifecycle snapshot${presentation ? ` (${readiness})` : ''}:\n` + cluster.lifecycle.map((item) => `${item.label.padEnd(18)} ${item.state.padEnd(8)} ${item.detail}`).join('\n') }]
  }
  if (normalized.includes('evidence')) {
    return [{ kind: 'output', content: `This shell session holds the following evidence snapshot:\nEVIDENCE     ${cluster.evidenceId}\nCONTRACT     ${cluster.contractVersion}\nREVISION     ${cluster.revision}\nREADINESS    ${readiness}\nSOURCE       ${source ?? 'unspecified'}` }]
  }
  return [{ kind: 'blocked', content: 'UNKNOWN · This command is not in the prototype read-only allowlist. Type “help” to see supported diagnostics.' }]
}

function ClusterShell({ cluster, source, presentation, generation = 0, observedAt, close }: { cluster: Cluster; source: PlatformSnapshot['source']; presentation?: ReturnType<typeof observationPresentation>; generation?: number; observedAt?: string; close: () => void }) {
  const [previous, setPrevious] = useState({ generation, current: presentation?.current })
  const [namespace, setNamespace] = useState('all namespaces')
  const [command, setCommand] = useState('')
  const [entries, setEntries] = useState<ShellEntry[]>([
    { kind: 'system', content: `Read-only prototype session established for ${cluster.name}. No credential, kubeconfig, WebSocket, or backend connection was created.` },
  ])

  if (generation !== previous.generation || presentation?.current !== previous.current) {
    setPrevious({ generation, current: presentation?.current })
    setEntries(items => items.map(item => item.generation !== undefined &&
      (item.generation < generation || !presentation?.current) ? { ...item, historical: true } : item))
  }

  const run = (value = command) => {
    const nextCommand = value.trim()
    if (!nextCommand) return
    if (nextCommand === 'clear') {
      setEntries([])
      setCommand('')
      return
    }
    setEntries((current) => [...current, { kind: 'command', content: nextCommand }, ...simulatedShellResponse(nextCommand, cluster, source, presentation).map(item => ({ ...item, generation, observedAt, historical: false }))])
    setCommand('')
  }

  return <div className="shell-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
    <section className="cluster-shell" role="dialog" aria-modal="true" aria-labelledby="shell-title">
      <header className="shell-header">
        <div className="shell-identity"><span className="shell-logo"><Icon name="terminal" size={22}/></span><div><span className="eyebrow">Cluster diagnostic session</span><h2 id="shell-title">Shell · {cluster.name}</h2></div></div>
        <div className="shell-session"><span className="session-dot"/><span><small>Read-only prototype</small><strong>14:37 remaining</strong></span></div>
        <button className="shell-close" onClick={close} aria-label="Close cluster shell"><Icon name="x"/></button>
      </header>
      <div className="shell-context">
        <div><span>Cluster</span><strong><Icon name={cluster.role === 'Management plane' ? 'shield' : 'cube'} size={14}/>{cluster.name}</strong></div>
        <label><span>Namespace</span><select aria-label="Shell namespace" value={namespace} onChange={(event) => setNamespace(event.target.value)}><option>all namespaces</option></select></label>
        <div><span>Authority</span><strong>diagnostics.read</strong></div>
        <div><span>Session evidence</span><strong>shell/{cluster.name}/demo-01</strong></div>
      </div>
      {cluster.role === 'Management plane' && <div className="management-warning"><Icon name="shield"/><strong>Management Plane guardrail</strong><span>This session has the strictest diagnostic-only policy. Mutations and interactive exec are unavailable.</span></div>}
      <div className="shell-toolbar"><span>Try a safe diagnostic</span><div>{['kubectl get clusterconditions -o wide', 'ok evidence explain'].map((item) => <button key={item} onClick={() => run(item)}>{item}</button>)}</div></div>
      <div className="terminal-output" role="log" aria-live="polite">
        {entries.map((entry, index) => <div className={`terminal-entry terminal-${entry.kind}`} key={`${entry.kind}-${index}`}>
          {entry.kind === 'command' && <span className="terminal-prompt">{cluster.name}<i>:</i>{namespace === 'all namespaces' ? '*' : namespace}<b>$</b></span>}
          {entry.kind === 'ai' && <span className="entry-label"><Icon name="spark" size={14}/>AI explanation</span>}
          {entry.kind === 'proposal' && <span className="entry-label"><Icon name="shield" size={14}/>Reviewable proposal</span>}
          {entry.kind === 'blocked' && <span className="entry-label"><Icon name="x" size={14}/>Guardrail</span>}
          {entry.kind === 'system' && <span className="entry-label"><Icon name="check" size={14}/>Session boundary</span>}
          {entry.historical && <small>Earlier output, based on data observed at {entry.observedAt && new Date(entry.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>}
          <pre>{observedText(entry.content, !entry.historical)}</pre>
          {entry.kind === 'proposal' && <button onClick={() => run('kubectl get clusterconditions -o wide')}>Run proposed read-only command <Icon name="arrow" size={14}/></button>}
        </div>)}
      </div>
      <form className="terminal-command" onSubmit={(event) => { event.preventDefault(); run() }}>
        <label className="sr-only" htmlFor="cluster-shell-command">Command or question</label>
        <span><strong>{cluster.name}</strong>:{namespace === 'all namespaces' ? '*' : namespace}$</span>
        <input id="cluster-shell-command" autoFocus value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Type a read-only command or ask why…" autoComplete="off"/>
        <button type="submit">Run <Icon name="arrow" size={15}/></button>
      </form>
      <footer className="shell-footer"><span><Icon name="shield" size={13}/>No live connection · no credentials · no mutation</span><span>Commands and explanations would be evidence-correlated in production.</span></footer>
    </section>
  </div>
}

function EvidenceDrawer({ item, close, fixture, observedStale = false }: { item: EvidenceRef; close: () => void; fixture: boolean; observedStale?: boolean }) {
  const staleReason = Date.parse(item.observedAt) > Date.now() + 60_000
    ? 'dated in the future (clock fault)'
    : 'older than the freshness window'
  const presentation = evidencePresentation(item, fixture)
  const durability = presentation.stale || observedStale
    ? `${item.immutable ? 'Immutable receipt · ' : ''}Stale observation: ${staleReason}`
    : item.immutable ? presentation.label : presentation.current ? 'Current, freshness-bound observation' : presentation.label
  return <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}><aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-title"><header><div><span className="eyebrow">{item.type}</span><h2 id="evidence-title">{item.title}</h2></div><button className="icon-button" onClick={close} aria-label="Close evidence"><Icon name="x"/></button></header><EvidenceOutcome item={item} fixture={fixture}/><p className="drawer-summary">{observedText(item.summary, presentation.current)}</p><dl className="evidence-details"><div><dt>Cluster</dt><dd>{item.cluster}</dd></div><div><dt>Contract</dt><dd>{item.contract}</dd></div><div><dt>Revision / digest</dt><dd>{item.revision}</dd></div><div><dt>Source</dt><dd>{item.source}</dd></div><div><dt>Observed at</dt><dd>{new Date(item.observedAt).toLocaleString()}</dd></div><div><dt>Durability</dt><dd>{durability}</dd></div></dl><div className="provenance-box"><Icon name="shield"/><div><strong>Provenance visible</strong><p>This projection is redaction-safe fixture data. It does not expose credentials, kubeconfigs, or raw private evidence.</p></div></div><button className="secondary-button full-button" onClick={close}>Close</button></aside></div>
}

export default function App({ auth = consoleAuth }: { auth?: ConsoleAuthClient }) {
  const branding = useBranding()
  const terms = useBrandTerms()
  const policy = useDeploymentPolicy()
  const [session, setSession] = useState<PrototypeSession>()
  const [authStatus, setAuthStatus] = useState<'checking' | 'ready'>(auth.mode === 'prototype' ? 'ready' : 'checking')
  const [authError, setAuthError] = useState<string>()
  const [authAttempt, setAuthAttempt] = useState(0)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string>()
  const [page, setPage] = useState<Page>(pageFromHash)
  const [selectedCluster, setSelectedCluster] = useState<Cluster>()
  const [shellCluster, setShellCluster] = useState<Cluster>()
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceRef>()
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (auth.mode === 'prototype') return
    let active = true
    setAuthStatus('checking')
    setAuthError(undefined)
    auth.restoreSession()
      .then((restored) => { if (active) setSession(restored ?? undefined) })
      .catch((error: unknown) => {
        if (active) setAuthError(error instanceof ConsoleAuthError ? error.message : 'The authentication service is unavailable.')
      })
      .finally(() => { if (active) setAuthStatus('ready') })
    return () => { active = false }
  }, [auth, authAttempt])

  const signOut = async () => {
    setSigningOut(true)
    setSignOutError(undefined)
    try {
      await auth.logout()
      setSelectedCluster(undefined)
      setSelectedEvidence(undefined)
      setShellCluster(undefined)
      setSession(undefined)
      window.location.hash = '#/overview'
    } catch (error) {
      setSignOutError(error instanceof ConsoleAuthError ? error.message : 'Sign-out could not be completed safely.')
    } finally {
      setSigningOut(false)
    }
  }

  const endSession = () => {
    setSelectedCluster(undefined); setSelectedEvidence(undefined); setShellCluster(undefined)
    setSession(undefined); setAuthError('Your session ended. Sign in again.')
  }
  const observation = useObservationSnapshot(Boolean(session), selectedCluster, endSession)
  const clusterDetailError = observation.detailError
  const effectiveDetail = observation.detail
  const data = observation.data && {
    ...observation.data,
    evidence: observation.data.evidence.map(item => effectiveDetail &&
      (item.cluster === effectiveDetail.id || item.cluster === effectiveDetail.name)
      ? { ...item, freshness: conservativeVerdict(item.freshness, effectiveDetail.freshness, effectiveDetail.readiness === 'Unknown' ? 'Unknown' : 'Current') } : item),
  }
  const openCluster = (cluster: Cluster) => setSelectedCluster(cluster)
  useEffect(() => {
    const onHash = () => {
      setPage(pageFromHash())
      setSelectedCluster(undefined)
      setShellCluster(undefined)
      setMenuOpen(false)
      window.scrollTo({ top: 0, behavior: 'auto' })
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && (setSelectedEvidence(undefined), setShellCluster(undefined), setMenuOpen(false))
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const title = useMemo(() => !session ? 'Sign in' : selectedCluster?.name ?? (page === 'users' ? 'User & Project Management' : page === 'wjax' ? 'W-JAX Local Kubernetes' : page === 'create' ? 'Create Cluster' : page === 'register' ? 'Register Existing Cluster' : NAV.find((item) => item.id === page)?.label), [page, selectedCluster, session])
  useEffect(() => { document.title = `${title} · ${branding.productName}` }, [title, branding.productName])

  if (authStatus === 'checking') return <AuthLoading/>
  if (!session) return <AuthEntry onAuthenticated={setSession} authMode={auth.mode} onStartOidc={auth.startOidc} onAuthenticateLocal={auth.authenticateLocal} serviceError={authError} onRetry={() => setAuthAttempt((attempt) => attempt + 1)}/>
  if (observation.error && !data) return <LoadFailure error={observation.error} retry={observation.retry}/>
  if (!data) return <EmptyLoading/>
  const latestShellCluster = shellCluster && (effectiveDetail?.id === shellCluster.id ? effectiveDetail : data.clusters.find(item => item.id === shellCluster.id) ?? { ...shellCluster, freshness: 'Unknown' as const })
  const publicDemo = publicDemoBuild() && auth.mode === 'prototype' && consoleDataMode === 'fixture'
  const view = selectedCluster
    ? <ClusterDetail cluster={effectiveDetail ?? selectedCluster} data={data} detailError={clusterDetailError} close={() => { setSelectedCluster(undefined) }} openEvidence={setSelectedEvidence} openShell={(cluster) => { setSelectedEvidence(undefined); setShellCluster(cluster) }}/>
    : page === 'wjax' && wjaxLocalPreviewEnabled && WjaxClusterView
      ? <Suspense fallback={<p role="status">Loading local Kubernetes view…</p>}><WjaxClusterView/></Suspense>
    : page === 'users' && wjaxLocalPreviewEnabled && UserProjectManagement
      ? <Suspense fallback={<p role="status">Loading identity & access preview…</p>}><UserProjectManagement/></Suspense>
    : page === 'overview' ? <Overview data={data} identity={session.identity} publicDemo={publicDemo} openCluster={openCluster} openEvidence={setSelectedEvidence}/>
    : page === 'clusters' ? <Clusters data={data} openCluster={openCluster} openEvidence={setSelectedEvidence}/>
    : page === 'workloads' ? <Workloads claims={data.claims} data={data} openEvidence={setSelectedEvidence}/>
    : page === 'workspaces' ? <DeveloperWorkspaces/>
    : page === 'agents' ? <Agents data={data} openEvidence={setSelectedEvidence}/>
    : page === 'capabilities' ? <Capabilities data={data} openEvidence={setSelectedEvidence}/>
    : page === 'evidence' ? <Evidence data={data} openEvidence={setSelectedEvidence}/>
    : !policy.clusterLifecycleAvailable ? <LifecycleUnavailable action={page === 'register' ? 'register' : 'create'}/>
    : page === 'register' ? <RegisterCluster/>
    : <CreateCluster onSessionEnded={endSession}/>

  return <div className="app-shell">
    <a href="#main-content" className="skip-link">Skip to content</a>
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
      <div className="brand"><img src={branding.logoUrl} alt={branding.logoAlt}/><div><strong>{branding.productShortName}</strong><span>{branding.productTagline}</span></div><button className="menu-close" onClick={() => setMenuOpen(false)} aria-label="Close navigation"><Icon name="x"/></button></div>
      <div className="context-switcher"><span className="context-mark">OK</span><span><small>Distribution</small><strong>OpenKubes Platform</strong></span><Icon name="chevron" size={15}/></div>
      <nav aria-label="Primary navigation">{NAV.map((item) => <a href={`#/${item.id}`} className={page === item.id && !selectedCluster ? 'active' : ''} key={item.id}><Icon name={item.id}/><span><strong>{item.label}</strong><small>{item.caption}</small></span></a>)}{wjaxLocalPreviewEnabled && <a href="#/users" className={page === 'users' ? 'active' : ''}><Icon name="shield"/><span><strong>User & Project Management</strong><small>Preview · identity & access</small></span></a>}</nav>
      <div className="sidebar-spacer"/>
      {policy.clusterLifecycleAvailable ? <div className="cluster-quick-actions"><a href="#/create" className={`create-nav ${page === 'create' ? 'active' : ''}`}><Icon name="create"/><span><strong>Create Cluster</strong><small>Draft a new contract</small></span></a><a href="#/register" className={`create-nav register-nav ${page === 'register' ? 'active' : ''}`}><Icon name="register"/><span><strong>Register Existing Cluster</strong><small>Connect external infrastructure</small></span></a></div> : <div className="cluster-quick-actions is-unavailable" role="group" aria-label="Cluster lifecycle: not available in this installation"><span className="create-nav" aria-disabled="true"><Icon name="create"/><span><strong>Create Cluster</strong><small>Not available · read-only</small></span></span><span className="create-nav register-nav" aria-disabled="true"><Icon name="register"/><span><strong>Register Existing Cluster</strong><small>Not available · read-only</small></span></span></div>}
      <PoweredBy className="sidebar-powered-by"/>
      <div className="sidebar-footer"><div className="avatar">{session.identity.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</div><span><strong>{session.identity}</strong><small>{signOutError ?? (publicDemo ? 'Simulated Session' : session.method === 'oidc' ? 'Federated identity' : auth.mode === 'local' ? 'Local development session' : 'Break-glass session')}</small></span><button className="signout-button" aria-label={`Sign out of ${branding.productName}`} disabled={signingOut} onClick={signOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button></div>
    </aside>
    {menuOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)}/>}
    <div className="main-column">
      <header className="topbar"><button className="mobile-menu" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Icon name="menu"/></button><div className="breadcrumbs"><span>{branding.productShortName}</span><Icon name="chevron" size={13}/><strong>{title}</strong></div><div className="top-actions"><label className="global-search"><Icon name="search"/><span className="sr-only">Search platform</span><input placeholder="Search contracts, clusters, evidence…"/><kbd>⌘ K</kbd></label><button className="icon-button notification" aria-label="Notifications"><Icon name="bell"/><span/></button><div className="environment"><span><small>Environment</small><strong>Community preview</strong></span></div></div></header>
      <main id="main-content" className="content" tabIndex={-1}>{publicDemo && <div role="note" aria-label="Simulated demo" style={{ padding: "12px 16px", marginBottom: 18, border: "1px solid #65a5d255", borderRadius: 10, background: "#e8f5ff", color: "#15375b", fontSize: 14 }}><strong>SIMULATED DEMO</strong> · Sample cluster data only. No live infrastructure or AI service is connected.</div>}{observation.error && <div className="data-warning" role="alert"><Icon name="clock"/><div><strong>Observation refresh failed</strong><span>{observation.error.message.slice(0, 240)}{observation.error.correlationId ? ` · Correlation ID ${observation.error.correlationId.slice(0, 128)}` : ''}</span><button className="secondary-button" disabled={observation.loading} onClick={observation.retry}>Retry safely</button></div></div>}{view}<footer className="product-footer"><span>{terms.whiteLabel ? `${branding.productName} Prototype · Built on OpenKubes Console` : 'OpenKubes Console Prototype · OK-153 / OK-154 / OK-159'}</span><span>{page === 'wjax' && wjaxLocalPreviewEnabled ? 'W-JAX local Reader · read-only Kubernetes observation' : <>{data.presentationVersion} · {consoleDataMode === 'bff' ? 'Console BFF' : 'deterministic fixtures'}</>}</span></footer></main>
    </div>
    {!(page === 'wjax' && wjaxLocalPreviewEnabled) && <DiagnosticWidget generation={observation.generation} data={data} openEvidence={setSelectedEvidence}/>}
    {selectedEvidence && <EvidenceDrawer observedStale={observation.originalEvidence?.some(item => item.id === selectedEvidence.id && item.freshness === 'Stale')} fixture={data.source !== 'bff'} item={data.evidence.find(item => item.id === selectedEvidence.id) ?? { ...selectedEvidence, freshness: 'Unknown' }} close={() => setSelectedEvidence(undefined)}/>}
    {latestShellCluster && <ClusterShell generation={observation.generation} observedAt={data.generatedAt} cluster={latestShellCluster} source={data.source} presentation={consoleDataMode === 'bff' ? clusterPresentation(latestShellCluster, data) : undefined} close={() => setShellCluster(undefined)}/>}
  </div>
}
