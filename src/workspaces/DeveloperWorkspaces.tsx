import { useEffect, useRef, useState } from 'react'
import './workspaces.css'

type Profile = 'persistent' | 'ephemeral' | 'review'
type Workspace = {
  id: string; name: string; repository: string; revision: string; profile: Profile
  status: 'Running' | 'Completed' | 'Pending'; task: string; cpu: string; memory: string; storage: string
}
const examples: Workspace[] = [
  { id: 'ws-console', name: 'Console development', repository: 'openkubes/ok-console', revision: 'feature/workspace-preview', profile: 'persistent', status: 'Running', task: 'Build the Developer Workspace preview', cpu: '2', memory: '4 GiB', storage: '20 GiB persistent' },
  { id: 'ws-review', name: 'Pull request review', repository: 'openkubes/openkubes', revision: 'review/contract-update', profile: 'review', status: 'Completed', task: 'Review contract changes and export findings', cpu: '1', memory: '2 GiB', storage: '4 GiB ephemeral' },
  { id: 'ws-tests', name: 'Contract test runner', repository: 'openkubes/openkubes', revision: 'main', profile: 'ephemeral', status: 'Pending', task: 'Run contract checks for one bounded task', cpu: '2', memory: '4 GiB', storage: '8 GiB ephemeral' },
]
const profiles: Record<Profile, { title: string; description: string; retention: string }> = {
  persistent: { title: 'Persistent', description: 'A recurring development environment. Keep working files across runtime restarts.', retention: 'Keep storage across runtime restarts; final deletion is explicit.' },
  ephemeral: { title: 'Ephemeral', description: 'One bounded task. Export results before the environment is removed.', retention: 'Demo policy: export evidence, then remove workspace after 24 hours.' },
  review: { title: 'Review', description: 'Inspect a change with read-only Git access and restricted tools.', retention: 'Demo policy: export review findings, then remove workspace after 24 hours.' },
}
function Facts({ rows }: { rows: [string, string][] }) {
  return <dl className="ws-facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

export default function DeveloperWorkspaces() {
  const [selected, setSelected] = useState<Workspace>()
  const [screen, setScreen] = useState<'list' | 'configure' | 'review' | 'done'>('list')
  const [name, setName] = useState('W-JAX demo workspace')
  const [repository, setRepository] = useState('openkubes/ok-console')
  const [revision, setRevision] = useState('main')
  const [profile, setProfile] = useState<Profile>('ephemeral')
  const [size, setSize] = useState('standard')
  const [inference, setInference] = useState(true)
  const [tools, setTools] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [screen, selected])
  const back = () => { setSelected(undefined); setScreen('list') }
  const start = () => {
    setSelected(undefined); setName('W-JAX demo workspace'); setRepository('openkubes/ok-console')
    setRevision('main'); setProfile('ephemeral'); setSize('standard'); setInference(true); setTools(false); setScreen('configure')
  }
  const summary = {
    previewOnly: true, name: name.trim(), source: { repository, revision: revision.trim() },
    runtimeProfile: 'opencode', lifecycleProfile: profile, target: 'Worker cluster · demo placement',
    resources: size === 'standard' ? { cpu: '2', memory: '4 GiB' } : { cpu: '1', memory: '2 GiB' },
    storage: profile === 'persistent' ? '20 GiB persistent' : '8 GiB ephemeral',
    capabilities: { git: profile === 'review' ? 'read-only' : 'workspace edits; no push', inference: inference ? 'ok-ai' : 'none', tools: tools ? ['documentation search (read-only)'] : [], kubernetes: 'none' },
    retention: profiles[profile].retention,
  }
  const title = selected?.name ?? (screen === 'list' ? 'Developer Workspaces' : screen === 'configure' ? 'Create Workspace' : screen === 'review' ? 'Review workspace configuration' : 'Workspace preview complete')
  return <div className="ws-preview">
    <header className="page-title"><div><div className="eyebrow">Developer experience · ADR-Platform-039</div><h1 ref={heading} tabIndex={-1}>{title}</h1><p>From a development task to a reviewable change, inside a bounded workspace.</p></div><span className="prototype-badge">Preview · fixture data</span></header>
    <div className="ws-notice" role="note"><strong>Interactive preview</strong><span>All workspace states, placements and results are illustrative. No workspace, credentials or backend resources are created.</span></div>
    {screen === 'list' && !selected && <>
      <section className="ws-hero"><div><span className="eyebrow">Your code. Your boundaries.</span><h2>A workspace for every way of building.</h2><p>Give developers and coding agents explicit source, compute and tool access — with evidence that survives the task.</p><button className="primary-button" onClick={start}>Create Workspace <span aria-hidden="true">→</span></button></div><ol className="ws-journey" aria-label="Workspace journey"><li><span>01</span><strong>Declare</strong><small>Source & capabilities</small></li><li><span>02</span><strong>Develop</strong><small>Isolated runtime</small></li><li><span>03</span><strong>Review</strong><small>Changes & evidence</small></li></ol></section>
      <div className="section-heading"><div><span className="eyebrow">Example environments</span><h2>Workspaces</h2></div><span className="count-badge">3 examples</span></div>
      <section className="ws-cards" aria-label="Example workspaces">{examples.map((ws) => <article className="ws-card" key={ws.id}><div className="ws-card-top"><span className="ws-code" aria-hidden="true">&lt;/&gt;</span><span className={`ws-status ws-${ws.status.toLowerCase()}`}>{ws.status} · demo</span></div><span className="eyebrow">{profiles[ws.profile].title}</span><h3>{ws.name}</h3><p>{ws.task}</p><Facts rows={[["Repository", ws.repository], ['Revision', ws.revision], ['Runtime', 'OpenCode'], ['Compute', `${ws.cpu} CPU · ${ws.memory}`]]}/><button className="secondary-button" onClick={() => setSelected(ws)}>Inspect {ws.name} <span aria-hidden="true">→</span></button></article>)}</section>
      <p className="ws-footnote">One DeveloperWorkspace contract · replaceable coding runtimes · explicit capabilities · human review and merge authority</p>
    </>}
    {selected && <>
      <button className="text-button ws-back" onClick={back}>← All workspaces</button>
      <div className="ws-detail-grid"><section className="ws-panel"><div className="ws-panel-heading"><h2>Workspace contract</h2><span className={`ws-status ws-${selected.status.toLowerCase()}`}>{selected.status} · demo</span></div><Facts rows={[
        ['Workspace ID', selected.id], ['Repository', selected.repository], ['Revision', selected.revision], ['Runtime profile', 'OpenCode · replaceable'], ['Lifecycle', profiles[selected.profile].title], ['Placement', 'Worker cluster · example'], ['Compute', `${selected.cpu} CPU · ${selected.memory}`], ['Storage', selected.storage], ['Retention', profiles[selected.profile].retention],
      ]}/></section><section className="ws-panel"><span className="eyebrow">Explicit authority</span><h2>Capabilities & isolation</h2><Facts rows={[
        ['Git', selected.profile === 'review' ? 'Read-only source access' : 'Source checkout & workspace edits; no push'], ['Inference', 'ok-ai · scoped model access'], ['Tools / MCP', selected.profile === 'review' ? 'Documentation search · read-only' : 'None requested'], ['Kubernetes API', 'None'], ['Network', 'Default deny; declared destinations only'], ['Identity', 'Dedicated workspace identity'], ['Merge / deploy', 'Requires separate authorization'],
      ]}/></section></div>
      <section className="ws-panel ws-result"><span className="eyebrow">Illustrative evidence · never a live result</span><h2>{selected.status === 'Pending' ? 'Awaiting runtime readiness' : selected.status === 'Completed' ? 'Review evidence exported' : 'Development task in progress'}</h2><p>{selected.task}</p>{selected.status === 'Pending' ? <p className="ws-notice">Example blocker: the runtime image is awaiting availability. No test outcome or successful task result is inferred.</p> : <><div className="ws-evidence-grid"><article><strong>01 · Source</strong><p>{selected.repository}<br/>{selected.revision}</p></article><article><strong>02 · {selected.status === 'Completed' ? 'Findings' : 'Working changes'}</strong><p>{selected.status === 'Completed' ? 'Example: contract review completed; findings exported.' : 'Example: workspace view and configuration flow under development.'}</p></article><article><strong>03 · Human review</strong><p>{selected.status === 'Completed' ? 'Example outcome: review completed. Merge remains a separate decision.' : 'Example next step: run checks and prepare a pull request.'}</p></article></div><p className="ws-footnote">Example receipt: demo/{selected.id}/task-01 · Historical task outcome and current runtime health are separate.</p></>}</section>
    </>}
    {screen !== 'list' && <>
      <button className="text-button ws-back" onClick={back}>← All workspaces</button>
      <ol className="ws-steps" aria-label="Preview steps">{['Configure', 'Review', 'Preview'].map((label, i) => <li key={label} aria-current={(screen === 'configure' ? 0 : screen === 'review' ? 1 : 2) === i ? 'step' : undefined}>{i + 1}. {label}</li>)}</ol>
      {screen === 'configure' && <form className="ws-panel" onSubmit={(event) => { event.preventDefault(); setScreen('review') }}><h2>Choose your environment</h2><div className="ws-form-grid">
        <label>Workspace name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} pattern=".*\S.*"/></label>
        <label>Repository<select value={repository} onChange={(e) => setRepository(e.target.value)}><option>openkubes/ok-console</option><option>openkubes/openkubes</option></select></label>
        <label>Source revision<input aria-label="Source revision" aria-describedby="ws-revision-hint" value={revision} onChange={(e) => setRevision(e.target.value)} required maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9._/\-]*"/><small id="ws-revision-hint">A branch, tag or commit, e.g. main.</small></label>
        <label>Compute profile<select value={size} onChange={(e) => setSize(e.target.value)}><option value="standard">Standard · 2 CPU / 4 GiB</option><option value="small">Small · 1 CPU / 2 GiB</option></select></label>
      </div><fieldset className="ws-profiles"><legend>Lifecycle profile</legend>{(Object.keys(profiles) as Profile[]).map((key) => <label key={key} className={profile === key ? 'selected' : ''}><input type="radio" name="lifecycle" value={key} checked={profile === key} onChange={() => setProfile(key)}/><strong>{profiles[key].title}</strong><span>{profiles[key].description}</span></label>)}</fieldset>
      <fieldset className="ws-options"><legend>Declared capabilities</legend><label><input type="checkbox" checked={inference} onChange={(e) => setInference(e.target.checked)}/>Model access through ok-ai</label><label><input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)}/>Documentation search tool · read-only</label><p>Runtime: OpenCode · Kubernetes access: none · Git push: disabled</p></fieldset><div className="ws-actions"><button className="secondary-button" type="button" onClick={back}>Cancel</button><button className="primary-button" type="submit" disabled={!name.trim() || !revision.trim()}>Review configuration →</button></div></form>}
      {screen === 'review' && <div className="ws-detail-grid"><section className="ws-panel"><h2>Review boundaries</h2><Facts rows={[
        ['Name', summary.name], ['Source', `${repository} @ ${revision}`], ['Lifecycle', profiles[profile].title], ['Compute', `${summary.resources.cpu} CPU · ${summary.resources.memory}`], ['Storage', summary.storage], ['Git access', summary.capabilities.git], ['Model access', summary.capabilities.inference], ['Tools', summary.capabilities.tools.join(', ') || 'None'], ['Kubernetes access', 'None'], ['Retention', summary.retention],
      ]}/><div className="ws-actions"><button className="secondary-button" onClick={() => setScreen('configure')}>Back to configuration</button><button className="primary-button" onClick={() => setScreen('done')}>Finish preview</button></div></section><section className="ws-panel"><span className="eyebrow">Illustrative configuration</span><h2>Workspace intent</h2><p>UI summary for this preview; not a deployable API manifest.</p><pre className="ws-json" tabIndex={0} aria-label="Workspace intent preview">{JSON.stringify(summary, null, 2)}</pre></section></div>}
      {screen === 'done' && <section className="ws-panel ws-complete" role="status"><span className="ws-complete-mark" aria-hidden="true">✓</span><span className="eyebrow">Configuration reviewed</span><h2>Your workspace intent is ready to discuss.</h2><p><strong>{name.trim()}</strong> · {profiles[profile].title} · OpenCode</p><p>This concludes the preview. No workspace was provisioned and no request was sent.</p><div className="ws-actions"><button className="secondary-button" onClick={start}>Try another configuration</button><button className="primary-button" onClick={back}>Return to workspaces</button></div></section>}
    </>}
  </div>
}
