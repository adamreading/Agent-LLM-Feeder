import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const

interface AgentStatus { status: string; workspaceRoot: string; capabilities: string[] }
interface AgentFiles { files: string[]; total: number }
interface AgentReply { content: string; routedVia?: { platform: string; model: string; displayName: string } }

const panel: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--panel)', padding: 16 }

export default function AgentPage() {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [reply, setReply] = useState<AgentReply | null>(null)

  const { data: status } = useQuery<AgentStatus>({ queryKey: ['agent', 'status'], queryFn: () => apiFetch('/api/agent/status') })
  const { data: filesData, refetch } = useQuery<AgentFiles>({ queryKey: ['agent', 'files', query], queryFn: () => apiFetch(`/api/agent/files?q=${encodeURIComponent(query)}`) })
  const ask = useMutation({
    mutationFn: (body: { message: string; paths: string[]; language: string }) => apiFetch<AgentReply>('/api/agent/chat', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: setReply,
  })

  const files = filesData?.files ?? []
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const toggleFile = (f: string) => setSelected(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f].slice(0, 8))
  const runAgent = () => { const t = message.trim(); if (!t || ask.isPending) return; ask.mutate({ message: t, paths: selected, language: 'en' }) }

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '36px 28px 80px', animation: 'flickin .35s ease' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// LOCAL AGENT UPLINK</div>
          <h1 style={{ margin: 0, fontSize: 40, fontWeight: 700, letterSpacing: 1, textShadow: '0 0 24px var(--glow)' }}>AGENT</h1>
        </div>
        <button onClick={() => refetch()} className="cy-hover-acc" style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 11, fontWeight: 700, letterSpacing: 1, border: '1px solid var(--line)', color: 'var(--dim)', padding: '8px 12px' }}>⟳ REFRESH</button>
      </div>

      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'minmax(0,360px) 1fr' }}>
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <section style={panel}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>WORKSPACE</h2>
              <span style={{ ...mono, fontSize: 9, letterSpacing: 1, color: 'var(--good)', border: '1px solid var(--good)', padding: '2px 6px' }}>{status ? 'READY' : '…'}</span>
            </div>
            <p style={{ margin: '8px 0 0', ...mono, fontSize: 11, color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status?.workspaceRoot ?? '…'}</p>
            <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--dim)' }}>Attach workspace files as context, then task the local agent.</p>
          </section>

          <section style={panel}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>FILES</h2>
              <span style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>{files.length}</span>
            </div>
            <input className="cy-input cy-mono" value={query} onChange={e => setQuery(e.target.value)} placeholder="▸ filter files…" style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 12, padding: '8px 10px', marginBottom: 10 }} />
            <div style={{ maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {files.map(file => {
                const active = selectedSet.has(file)
                return (
                  <button key={file} onClick={() => toggleFile(file)} className="cy-hover-acc" style={{
                    all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                    fontSize: 11.5, ...mono, border: `1px solid ${active ? 'var(--acc)' : 'transparent'}`,
                    color: active ? 'var(--ink)' : 'var(--dim)', background: active ? 'var(--bg2)' : 'transparent',
                  }}>
                    <span style={{ color: 'var(--acc2)' }}>▸</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 9, color: active ? 'var(--acc)' : 'var(--dim)' }}>{active ? '✕' : '+'}</span>
                  </button>
                )
              })}
              {files.length === 0 && <span style={{ ...mono, fontSize: 11, color: 'var(--dim)', padding: 8 }}>no files</span>}
            </div>
          </section>
        </aside>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={panel}>
            <h2 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>ATTACHED CONTEXT</h2>
            {selected.length === 0 ? (
              <p style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>▸ no files attached</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {selected.map(file => (
                  <span key={file} style={{ display: 'flex', alignItems: 'center', gap: 6, ...mono, fontSize: 10, border: '1px solid var(--line)', padding: '3px 6px', maxWidth: '100%' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file}</span>
                    <button onClick={() => toggleFile(file)} style={{ all: 'unset', cursor: 'pointer', color: 'var(--bad)' }}>✕</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div style={panel}>
            <label style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>PROMPT</label>
            <textarea className="cy-input" value={message} onChange={e => setMessage(e.target.value)} placeholder="▸ task the agent…" style={{ width: '100%', boxSizing: 'border-box', minHeight: 150, resize: 'vertical', background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 13, padding: '10px 12px', fontFamily: "'Chakra Petch',sans-serif" }} />
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={runAgent} disabled={!message.trim() || ask.isPending} className="cy-btn" style={{ all: 'unset', cursor: 'pointer', fontSize: 13, fontWeight: 700, letterSpacing: 1, padding: '9px 18px', background: 'var(--acc)', color: '#000', border: '1px solid var(--acc)', opacity: !message.trim() || ask.isPending ? 0.5 : 1 }}>{ask.isPending ? 'RUNNING…' : '▸ RUN AGENT'}</button>
            </div>
            {ask.isError && <p style={{ marginTop: 12, fontSize: 12, color: 'var(--bad)', ...mono }}>{(ask.error as Error).message}</p>}
          </div>

          <div style={panel}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>RESPONSE</h2>
              {reply?.routedVia && <span style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>via {reply.routedVia.platform}/{reply.routedVia.model}</span>}
            </div>
            {reply ? (
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.55 }}>{reply.content}</div>
            ) : (
              <p style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>▸ awaiting task</p>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
