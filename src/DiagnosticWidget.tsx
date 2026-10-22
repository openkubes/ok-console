import { useState, type FormEvent } from 'react'
import type { EvidenceRef, PlatformSnapshot } from './domain/contracts'

interface Message {
  id: number
  role: 'assistant' | 'user'
  text: string
  evidence?: EvidenceRef
}

function answerDiagnosticQuestion(question: string, data: PlatformSnapshot): Omit<Message, 'id' | 'role'> {
  const normalized = question.toLowerCase()
  const cluster = data.clusters.find((item) => normalized.includes(item.name.toLowerCase()))

  if (cluster) {
    const evidence = data.evidence.find((item) => item.id === cluster.evidenceId)
    return {
      text: `${cluster.name} is currently shown as ${cluster.readiness}. ${cluster.profile}; provider ${cluster.provider}; Kubernetes ${cluster.version}. This is a read-only summary of the Console's current observation.${evidence ? ` Evidence: ${evidence.title} (${evidence.outcome}).` : ''}`,
      evidence,
    }
  }

  const ready = data.clusters.filter((item) => item.readiness === 'Ready').length
  const nonReady = data.clusters.length - ready
  return {
    text: `The Console currently observes ${data.clusters.length} cluster${data.clusters.length === 1 ? '' : 's'}: ${ready} Ready and ${nonReady} needing attention or with unknown readiness. Observation freshness is ${(data.freshness ?? 'Unknown').toLowerCase()}.${data.warnings?.length ? ` Note: ${data.warnings[0]}` : ''} Ask about a named cluster (for example, ok-shared) for its observed status and evidence.`,
  }
}

export default function DiagnosticWidget({ data, openEvidence }: { data: PlatformSnapshot; openEvidence: (item: EvidenceRef) => void }) {
  const [isOpen, setIsOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<Message[]>([{
    id: 0,
    role: 'assistant',
    text: 'Hi, I’m the OK AI Diagnostic preview. I can summarize the cluster observations and evidence currently shown in this Console. I’m read-only; no live AI service or cluster actions are connected.',
  }])

  const ask = (value: string) => {
    const prompt = value.trim()
    if (!prompt) return
    const id = Date.now()
    setMessages((items) => [
      ...items,
      { id, role: 'user', text: prompt },
      { id: id + 1, role: 'assistant', ...answerDiagnosticQuestion(prompt, data) },
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
          <p>{message.text}</p>
          {message.evidence && <button className="diagnostic-evidence" onClick={() => openEvidence(message.evidence!)}>View evidence · {message.evidence.title}</button>}
        </div>)}
      </div>
      <div className="diagnostic-prompts"><button onClick={() => ask('Platform status')}>Platform status</button><button onClick={() => ask('ok-shared status')}>ok-shared status</button></div>
      <form className="diagnostic-form" onSubmit={submit}><label className="sr-only" htmlFor="diagnostic-question">Ask OK AI Diagnostic</label><input id="diagnostic-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about observed status…"/><button type="submit" disabled={!question.trim()}>Send</button></form>
      <p className="diagnostic-disclaimer">Read-only preview · No live AI · No cluster changes</p>
    </section>}
    <button className={`diagnostic-launcher ${isOpen ? 'active' : ''}`} aria-expanded={isOpen} onClick={() => setIsOpen((open) => !open)}><span aria-hidden="true">✦</span> Ask OK AI <small>PREVIEW</small></button>
  </div>
}
