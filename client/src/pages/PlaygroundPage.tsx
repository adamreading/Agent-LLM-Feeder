import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { platformColor } from '@/lib/cyber'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const

interface FallbackEntry {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  keyCount: number
  status: 'eligible' | 'disabled' | 'no_key' | 'cooling'
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  meta?: { platform?: string; model?: string; latency?: number; fallbackAttempts?: number }
}

const CHAT_SESSION_KEY = 'llm-chatbot:chat-session'

function loadChatSession(): ChatMessage[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = sessionStorage.getItem(CHAT_SESSION_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((m: any) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
  } catch { return [] }
}
function saveChatSession(m: ChatMessage[]) { if (typeof window !== 'undefined') sessionStorage.setItem(CHAT_SESSION_KEY, JSON.stringify(m)) }
function clearChatSession() { if (typeof window !== 'undefined') sessionStorage.removeItem(CHAT_SESSION_KEY) }

export default function PlaygroundPage() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadChatSession())
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('auto')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const { data: keyData } = useQuery<{ apiKey: string }>({ queryKey: ['unified-key'], queryFn: () => apiFetch('/api/settings/api-key') })
  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({ queryKey: ['fallback-order'], queryFn: async () => (await apiFetch<{ rows: FallbackEntry[] }>('/api/fallback/order')).rows })
  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.status !== 'disabled')

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { saveChatSession(messages) }, [messages])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return
    const newMessages = [...messages, { role: 'user', content: text } as ChatMessage]
    setMessages(newMessages)
    setInput('')
    setLoading(true)
    inputRef.current?.focus()
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`
      const body: any = { messages: newMessages.map(m => ({ role: m.role, content: m.content })) }
      if (selectedModel !== 'auto') body.model = selectedModel
      const base = import.meta.env.BASE_URL.replace(/\/$/, '')
      const start = Date.now()
      const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) })
      const latency = Date.now() - start
      const routedVia = res.headers.get('X-Routed-Via')
      const fallbackAttempts = res.headers.get('X-Fallback-Attempts')
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
        setMessages([...newMessages, { role: 'assistant', content: `Error: ${err.error?.message ?? 'unknown error'}` }])
        return
      }
      const data = await res.json()
      const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2)
      const via = data._routed_via ?? (routedVia ? { platform: routedVia.split('/')[0], model: routedVia.split('/').slice(1).join('/') } : undefined)
      setMessages([...newMessages, { role: 'assistant', content, meta: { platform: via?.platform, model: via?.model, latency, fallbackAttempts: fallbackAttempts ? parseInt(fallbackAttempts) : undefined } }])
    } catch (err: any) {
      setMessages([...newMessages, { role: 'assistant', content: `Error: ${err.message}` }])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }
  const handleClear = () => { clearChatSession(); setMessages([]); inputRef.current?.focus() }

  const activeLabel = selectedModel === 'auto' ? 'AUTO // ROUTER PICKS' : (availableModels.find(m => m.modelId === selectedModel)?.displayName ?? selectedModel)

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '36px 28px 40px', animation: 'flickin .35s ease', height: 'calc(100vh - 140px)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// DIRECT UPLINK</div>
          <h1 style={{ margin: 0, fontSize: 40, fontWeight: 700, letterSpacing: 1, textShadow: '0 0 24px var(--glow)' }}>CHATBOT</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="cy-input cy-mono" value={selectedModel} onChange={e => setSelectedModel(e.target.value)} style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 12, padding: '8px 10px', minWidth: 240 }}>
            <option value="auto">AUTO // ROUTER PICKS</option>
            {availableModels.map(m => <option key={m.modelDbId} value={m.modelId}>{m.displayName} — {m.platform}</option>)}
          </select>
          {messages.length > 0 && (
            <button onClick={handleClear} className="cy-hover-acc" style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 11, fontWeight: 700, letterSpacing: 1, border: '1px solid var(--line)', color: 'var(--dim)', padding: '8px 12px' }}>CLEAR</button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', border: '1px solid var(--line)', background: 'var(--panel)', overflow: 'hidden', minHeight: 0 }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {messages.length === 0 ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
              <div style={{ maxWidth: 360 }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>▸ UPLINK IDLE</div>
                <p style={{ fontSize: 13, color: 'var(--dim)', marginTop: 8 }}>Routing through <span style={{ color: 'var(--acc)' }}>{activeLabel}</span>. Send a message to open the channel.</p>
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  <div style={{
                    maxWidth: '78%', padding: '10px 14px', fontSize: 13.5, lineHeight: 1.55,
                    border: `1px solid ${msg.role === 'user' ? 'var(--acc)' : 'var(--line)'}`,
                    background: msg.role === 'user' ? 'color-mix(in oklab, var(--acc) 14%, transparent)' : 'var(--bg2)',
                    color: 'var(--ink)',
                  }}>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                    {msg.meta && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', ...mono, fontSize: 10, color: 'var(--dim)' }}>
                        {msg.meta.platform && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: platformColor(msg.meta.platform) }} />{msg.meta.platform}</span>}
                        {msg.meta.model && <span>· {msg.meta.model}</span>}
                        {msg.meta.latency != null && <span style={{ color: 'var(--acc2)' }}>· {msg.meta.latency}ms</span>}
                        {msg.meta.fallbackAttempts != null && msg.meta.fallbackAttempts > 0 && <span style={{ color: 'var(--warn)' }}>· {msg.meta.fallbackAttempts} fallback{msg.meta.fallbackAttempts > 1 ? 's' : ''}</span>}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {loading && (
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <div className="cy-mono" style={{ border: '1px solid var(--line)', background: 'var(--bg2)', padding: '10px 14px', fontSize: 12, color: 'var(--acc)' }}>▸ receiving<span style={{ animation: 'ledpulse 1s infinite' }}>…</span></div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--line)', background: 'var(--bg2)', padding: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="▸ transmit…"
              rows={1}
              className="cy-input"
              style={{ flex: 1, resize: 'none', background: 'var(--bg)', border: '1px solid var(--line)', color: 'var(--ink)', padding: '10px 12px', fontSize: 13, minHeight: 40, maxHeight: 160, fontFamily: "'Chakra Petch',sans-serif" }}
              onInput={e => { const el = e.target as HTMLTextAreaElement; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px' }}
            />
            <button onClick={handleSend} disabled={loading || !input.trim()} className="cy-btn" style={{ all: 'unset', cursor: 'pointer', fontSize: 13, fontWeight: 700, letterSpacing: 1, padding: '11px 20px', background: 'var(--acc)', color: '#000', border: '1px solid var(--acc)', opacity: loading || !input.trim() ? 0.5 : 1 }}>{loading ? 'SENDING' : 'SEND'}</button>
          </div>
        </div>
      </div>
    </main>
  )
}
