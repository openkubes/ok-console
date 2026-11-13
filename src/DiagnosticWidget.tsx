import { useRef, useState, type FormEvent } from 'react'
import type { EvidenceRef, PlatformSnapshot } from './domain/contracts'
import { clusterPresentation, evidencePresentation, overviewPresentation, observedText } from './observationPresentation'

interface Message {
  id: number
  role: 'assistant' | 'user'
  text: string
  generation?: number
  observedAt?: string
  historical?: boolean
  qualified?: boolean
  evidence?: EvidenceRef
}

function answerDiagnosticQuestion(question: string, data: PlatformSnapshot): Omit<Message, 'id' | 'role'> {
  const normalized = question.toLowerCase()
  const cluster = data.clusters.find((item) => normalized.includes(item.name.toLowerCase()))

  const summary = overviewPresentation(data)
  if (cluster) {
    const evidence = data.evidence.find((item) => item.id === cluster.evidenceId && (item.cluster === cluster.id || item.cluster === cluster.name))
    const presentation = clusterPresentation(cluster, data)
    const basis = evidence && evidencePresentation(evidence, data.source !== 'bff')
    return {
      text: `${cluster.name}: ${presentation.current && !summary.current ? 'Last observed' : presentation.label}. ${presentation.current && summary.current ? cluster.readiness : `Last observed: ${cluster.readiness}` }. ${cluster.profile}; provider ${cluster.provider}; Kubernetes ${cluster.version}. This is a read-only summary of the Console's displayed observation.${evidence ? ` Evidence: ${evidence.title} (${basis?.current && summary.current ? evidence.outcome : `${basis?.current ? 'Last observed' : basis?.label}; last observed outcome: ${evidence.outcome}`}).` : ''}`,
      evidence,
    }
  }

  const ready = data.clusters.filter((item) => item.readiness === 'Ready' && clusterPresentation(item, data).current).length
  const nonReady = data.clusters.length - ready
  return {
    text: `The Console displays ${data.clusters.length} cluster${data.clusters.length === 1 ? '' : 's'}: ${ready} Ready and ${nonReady} needing attention or with unknown readiness. Observation freshness is ${summary.current ? 'current' : summary.label.replace(/\.$/, '')}.${data.warnings?.length ? ` Note: ${data.warnings.join(' ')}` : ''} Ask about a named cluster (for example, ok-shared) for its observed status and evidence.`,
  }
}

export default function DiagnosticWidget({ data, generation = 0, openEvidence }: { data: PlatformSnapshot; generation?: number; openEvidence: (item: EvidenceRef) => void }) {
  const summary = overviewPresentation(data)
  const [previous, setPrevious] = useState({ generation, current: summary.current })
  const nextId = useRef(1)
  const [isOpen, setIsOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<Message[]>([{
    id: 0,
    role: 'assistant',
    text: 'Hi, I’m the OK AI Diagnostic preview. I can summarize the cluster observations and evidence shown in this Console. I’m read-only; no live AI service or cluster actions are connected.',
  }])

  if (generation !== previous.generation || summary.current !== previous.current) {
    setPrevious({ generation, current: summary.current })
    setMessages(items => items.map(item => item.generation !== undefined &&
      (item.generation < generation || !summary.current) ? { ...item, historical: true } : item))
  }

  const ask = (value: string) => {
    const prompt = value.trim()
    if (!prompt) return
    const id = nextId.current
    nextId.current += 2
    setMessages((items) => [
      ...items,
      { id, role: 'user', text: prompt },
      { id: id + 1, role: 'assistant', generation, observedAt: data.generatedAt, qualified: !summary.current, ...answerDiagnosticQuestion(prompt, data) },
    ])
    setQuestion('')
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    ask(question)
  }

  return <div className="diagnostic-widget">
    {isOpen && <section className="diagnostic-panel" role="dialog" aria-label="OK AI Diagnostic preview">
      <header className="diagnostic-header"><span className="diagnostic-spark" aria-hidden="true">✦</span><span><strong>OK AI</strong><small>Diagnostic · Demo Preview</small></span><button type="button" aria-label="Close OK AI Diagnostic" onClick={() => setIsOpen(false)}>×</button></header>
      <div className="diagnostic-messages" aria-live="polite">
        {messages.map((message) => <div className={`diagnostic-message ${message.role}`} key={message.id}>
          {(message.historical || message.qualified) && <small>{message.historical ? 'Earlier answer, based on data observed at' : 'Answer based on data observed at'} {new Date(message.observedAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>}
          <p>{observedText(message.text, !message.historical && !message.qualified)}</p>
          {message.evidence && <button className="diagnostic-evidence" onClick={() => openEvidence(message.evidence!)}>View evidence · {observedText(message.evidence.title, !message.historical && !message.qualified)}</button>}
        </div>)}
      </div>
      <div className="diagnostic-prompts"><button onClick={() => ask('Platform status')}>Platform status</button><button onClick={() => ask('ok-shared status')}>ok-shared status</button></div>
      <form className="diagnostic-form" onSubmit={submit}><label className="sr-only" htmlFor="diagnostic-question">Ask OK AI Diagnostic</label><input id="diagnostic-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about observed status…"/><button type="submit" disabled={!question.trim()}>Send</button></form>
      <p className="diagnostic-disclaimer">Read-only preview · No live AI · No cluster changes</p>
    </section>}
    <button className={`diagnostic-launcher ${isOpen ? 'active' : ''}`} aria-expanded={isOpen} onClick={() => setIsOpen((open) => !open)}><span aria-hidden="true">✦</span> Ask OK AI <small>PREVIEW</small></button>
  </div>
}
