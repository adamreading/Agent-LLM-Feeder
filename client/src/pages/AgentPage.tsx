import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { platformColor } from '@/lib/cyber'
import { ChatMarkdown } from '@/components/Markdown'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const
const base = import.meta.env.BASE_URL.replace(/\/$/, '')
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i
const MAX_ATTACH = 8
const MAX_TEXT_CTX = 120_000

interface Root { label: string; path: string }
interface AgentStatus { status: string; platform: string; cwd: string; home: string; defaultRoot: string; roots: Root[]; writeEnabled: boolean }
interface BrowseEntry { name: string; path: string; type: 'dir' | 'file'; kind?: 'image' | 'text' | 'unknown'; blocked: boolean; hidden: boolean }
interface BrowseResp { path: string; parent: string | null; entries: BrowseEntry[] }
interface ReadFile { path: string; kind?: 'image' | 'text'; content?: string; dataUri?: string; mime?: string; size?: number; error?: string }
interface FallbackEntry { modelDbId: number; platform: string; modelId: string; displayName: string; keyCount: number; status: string }
interface SearchConfig { backend: string; providers: { id: string; keyed: boolean; keySet: boolean }[] }
interface SelectedFile { path: string; name: string; kind: 'image' | 'text' }
interface ReplyMeta { platform?: string; model?: string; latency?: number; fallbackAttempts?: number; taskClass?: string; augmented?: boolean }
interface Reply { content: string; meta?: ReplyMeta; skipped?: string[]; hadImage?: boolean }
interface OutputFile { name: string; size: number; mtime: number }

const fmtBytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

const panel: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--panel)', padding: 16 }
const WEBSEARCH_PREF_KEY = 'llm-agent:websearch'
const deriveKind = (p: string): 'image' | 'text' => (IMG_RE.test(p) ? 'image' : 'text')
const basename = (p: string) => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p

export default function AgentPage() {
  const [cwd, setCwd] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<SelectedFile[]>([])
  const [selectedModel, setSelectedModel] = useState('auto')
  const [webSearch, setWebSearch] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem(WEBSEARCH_PREF_KEY) === '1')
  const [message, setMessage] = useState('')
  const [reply, setReply] = useState<Reply | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)
  const [feedbackNote, setFeedbackNote] = useState<string | null>(null)
  const [saveName, setSaveName] = useState('')
  const [saveFormat, setSaveFormat] = useState<'md' | 'txt' | 'pdf'>('md')
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  const { data: keyData } = useQuery<{ apiKey: string }>({ queryKey: ['unified-key'], queryFn: () => apiFetch('/api/settings/api-key') })
  const { data: status } = useQuery<AgentStatus>({ queryKey: ['agent', 'status'], queryFn: () => apiFetch('/api/agent/status') })
  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({ queryKey: ['fallback-order'], queryFn: async () => (await apiFetch<{ rows: FallbackEntry[] }>('/api/fallback/order')).rows })
  const { data: searchCfg } = useQuery<SearchConfig>({ queryKey: ['search-config'], queryFn: () => apiFetch('/api/settings/search') })

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.status !== 'disabled')
  const activeSearch = searchCfg?.providers.find(p => p.id === searchCfg.backend)
  const searchAvailable = !!activeSearch && (!activeSearch.keyed || activeSearch.keySet)
  const apiKey = keyData?.apiKey
  const authHeaders = useMemo<Record<string, string>>(() => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {} as Record<string, string>), [apiKey])

  // Land on the repo root once status resolves.
  useEffect(() => { if (!cwd && status?.defaultRoot) { setCwd(status.defaultRoot); setPathInput(status.defaultRoot) } }, [status, cwd])

  const { data: browse, isError: browseErr, error: browseError } = useQuery<BrowseResp>({
    queryKey: ['agent', 'browse', cwd, !!apiKey],
    queryFn: () => apiFetch(`/api/agent/browse?path=${encodeURIComponent(cwd)}`, { headers: authHeaders }),
    enabled: !!cwd,
  })
  const { data: searchData } = useQuery<{ files: string[] }>({
    queryKey: ['agent', 'search', cwd, search, !!apiKey],
    queryFn: () => apiFetch(`/api/agent/files?root=${encodeURIComponent(cwd)}&q=${encodeURIComponent(search)}`, { headers: authHeaders }),
    enabled: !!cwd && search.trim().length > 0,
  })
  const { data: outputs, refetch: refetchOutputs } = useQuery<{ files: OutputFile[] }>({
    queryKey: ['agent', 'outputs', !!apiKey],
    queryFn: () => apiFetch('/api/agent/outputs', { headers: authHeaders }),
  })

  const selectedSet = useMemo(() => new Set(selected.map(s => s.path)), [selected])
  const imageCount = selected.filter(s => s.kind === 'image').length

  const navigate = (p: string) => { setCwd(p); setPathInput(p); setSearch('') }
  const toggleSelect = (path: string, kind: 'image' | 'text') => setSelected(prev =>
    prev.some(s => s.path === path)
      ? prev.filter(s => s.path !== path)
      : (prev.length >= MAX_ATTACH ? prev : [...prev, { path, name: basename(path), kind }]))

  const toggleWeb = () => setWebSearch(v => { const n = !v; if (typeof window !== 'undefined') window.localStorage.setItem(WEBSEARCH_PREF_KEY, n ? '1' : '0'); return n })

  // Rows to render: search results (flat, absolute) when filtering, else the
  // current directory listing (dirs first).
  const rows: BrowseEntry[] = search.trim()
    ? (searchData?.files ?? []).map(p => ({ name: basename(p), path: p, type: 'file', kind: deriveKind(p), blocked: false, hidden: basename(p).startsWith('.') }))
    : (browse?.entries ?? [])

  const sendFeedback = async (rating: 'up' | 'down') => {
    if (!reply?.meta) return
    setFeedback(rating); setFeedbackNote(null)
    try {
      const r = await fetch(`${base}/api/agent/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ rating, platform: reply.meta.platform, modelId: reply.meta.model, taskClass: reply.meta.taskClass ?? null, hadImage: !!reply.hadImage, consumer: 'agent-ui' }),
      })
      if (r.ok) { const d = await r.json(); if (d.visionDemoted) setFeedbackNote(`⚠ vision capability demoted for ${reply.meta.model} — router will stop sending it images`) }
    } catch { /* feedback is best-effort */ }
  }

  const saveOutput = async () => {
    if (!reply?.content) return
    setSaveMsg(null)
    try {
      const r = await fetch(`${base}/api/agent/output`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ filename: saveName.trim() || undefined, format: saveFormat, content: reply.content }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message ?? `save failed (HTTP ${r.status})`)
      const d = await r.json()
      setSaveMsg(`✓ saved ${d.name} (${fmtBytes(d.size)})`)
      refetchOutputs()
    } catch (e: any) { setSaveMsg(e.message) }
  }

  const downloadOutput = async (name: string) => {
    const r = await fetch(`${base}/api/agent/output/${encodeURIComponent(name)}`, { headers: authHeaders })
    if (!r.ok) return
    const blob = await r.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = name
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const deleteOutput = async (name: string) => {
    await fetch(`${base}/api/agent/output/${encodeURIComponent(name)}`, { method: 'DELETE', headers: authHeaders })
    refetchOutputs()
  }

  const runAgent = async () => {
    const text = message.trim()
    if (!text || loading) return
    setLoading(true); setError(null); setReply(null); setFeedback(null); setFeedbackNote(null); setSaveMsg(null)
    try {
      // 1. Pull file contents (text) / base64 (image) from the host.
      let files: ReadFile[] = []
      if (selected.length) {
        const rd = await fetch(`${base}/api/agent/read`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ paths: selected.map(s => s.path) }),
        })
        if (!rd.ok) throw new Error((await rd.json().catch(() => ({}))).error?.message ?? `read failed (HTTP ${rd.status})`)
        files = (await rd.json()).files
      }
      const skipped = files.filter(f => f.error).map(f => `${basename(f.path)}: ${f.error}`)
      const textFiles = files.filter(f => f.kind === 'text' && f.content)
      const imageFiles = files.filter(f => f.kind === 'image' && f.dataUri)

      // 2. Assemble an OpenAI request; images become image_url parts so the
      // router's vision gate can pick a vision-capable model.
      const system = 'You are a coding and analysis assistant connected to a read-only file browser on the host machine. When files are attached, cite them by path and be precise. When an image is attached, analyse exactly what is shown.'
      let userText = text
      if (textFiles.length) userText += '\n\nAttached files:\n\n' + textFiles.map(f => `File: ${f.path}\n\`\`\`\n${(f.content ?? '').slice(0, MAX_TEXT_CTX)}\n\`\`\``).join('\n\n')
      const userContent: any = imageFiles.length
        ? [{ type: 'text', text: userText }, ...imageFiles.map(f => ({ type: 'image_url', image_url: { url: f.dataUri } }))]
        : userText
      const body: any = { model: selectedModel, messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }] }
      if (webSearch && searchAvailable) body.augment = 'force'

      // 3. Route through /v1 — same path as the chatbot (augment, vision, classifier).
      const start = Date.now()
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify(body),
      })
      const latency = Date.now() - start
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message ?? `HTTP ${res.status}`)
      const data = await res.json()
      const routedVia = res.headers.get('X-Routed-Via')
      const via = data._routed_via ?? (routedVia ? { platform: routedVia.split('/')[0], model: routedVia.split('/').slice(1).join('/') } : undefined)
      const fb = res.headers.get('X-Fallback-Attempts')
      setReply({
        content: data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2),
        meta: {
          platform: via?.platform, model: via?.model, latency,
          fallbackAttempts: fb ? parseInt(fb) : undefined,
          taskClass: (data._task_class ?? res.headers.get('X-Task-Class')) || undefined,
          augmented: res.headers.get('X-Augmented') === 'web-search' || undefined,
        },
        skipped: skipped.length ? skipped : undefined,
        hadImage: imageFiles.length > 0,
      })
    } catch (err: any) {
      setError(err.message ?? 'Agent request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '36px 28px 80px', animation: 'flickin .35s ease' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// LOCAL AGENT UPLINK</div>
          <h1 style={{ margin: 0, fontSize: 40, fontWeight: 700, letterSpacing: 1, textShadow: '0 0 24px var(--glow)' }}>AGENT</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="cy-input cy-mono" value={selectedModel} onChange={e => setSelectedModel(e.target.value)} style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 12, padding: '8px 10px', minWidth: 220 }}>
            <option value="auto">AUTO // ROUTER PICKS</option>
            {availableModels.map(m => <option key={m.modelDbId} value={m.modelId}>{m.displayName} — {m.platform}</option>)}
          </select>
          {searchAvailable && (
            <button onClick={toggleWeb} title={`Web search via ${searchCfg?.backend ?? 'provider'} — ${webSearch ? 'ON' : 'OFF'}`} className="cy-hover-acc"
              style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 11, fontWeight: 700, letterSpacing: 1, padding: '8px 12px',
                border: `1px solid ${webSearch ? 'var(--acc2)' : 'var(--line)'}`, color: webSearch ? 'var(--acc2)' : 'var(--dim)',
                background: webSearch ? 'color-mix(in oklab, var(--acc2) 14%, transparent)' : 'transparent' }}>{webSearch ? '◉' : '◯'} WEB</button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'minmax(0,400px) 1fr' }}>
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <section style={panel}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>BROWSER</h2>
              <span style={{ ...mono, fontSize: 9, letterSpacing: 1, color: 'var(--good)', border: '1px solid var(--good)', padding: '2px 6px' }}>{status ? status.platform.toUpperCase() : '…'}</span>
            </div>

            {/* Quick roots */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {status?.roots.map(r => (
                <button key={r.path} onClick={() => navigate(r.path)} className="cy-hover-acc" title={r.path}
                  style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 10, letterSpacing: 0.5, border: '1px solid var(--line)', color: 'var(--dim)', padding: '4px 8px' }}>{r.label}</button>
              ))}
            </div>

            {/* Path jump */}
            <form onSubmit={e => { e.preventDefault(); navigate(pathInput.trim()) }} style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input className="cy-input cy-mono" value={pathInput} onChange={e => setPathInput(e.target.value)} placeholder="▸ /absolute/path or ~"
                style={{ flex: 1, minWidth: 0, background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 11, padding: '7px 9px' }} />
              <button className="cy-hover-acc" style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 11, fontWeight: 700, border: '1px solid var(--line)', color: 'var(--acc)', padding: '7px 10px' }}>GO</button>
            </form>

            {/* Current dir + up */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <button onClick={() => browse?.parent && navigate(browse.parent)} disabled={!browse?.parent} className="cy-hover-acc"
                style={{ all: 'unset', cursor: browse?.parent ? 'pointer' : 'default', ...mono, fontSize: 12, color: browse?.parent ? 'var(--acc2)' : 'var(--dim)', border: '1px solid var(--line)', padding: '3px 8px', opacity: browse?.parent ? 1 : 0.4 }}>↰ ..</button>
              <span style={{ ...mono, fontSize: 10, color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>{cwd || '…'}</span>
            </div>

            {/* Filter/search under cwd */}
            <input className="cy-input cy-mono" value={search} onChange={e => setSearch(e.target.value)} placeholder="▸ search files under here…"
              style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 12, padding: '8px 10px', marginBottom: 10 }} />

            <div style={{ maxHeight: 460, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {browseErr && !search.trim() && <span style={{ ...mono, fontSize: 11, color: 'var(--bad)', padding: 8 }}>{(browseError as Error)?.message ?? 'cannot read directory'}</span>}
              {rows.map(entry => {
                const active = selectedSet.has(entry.path)
                const isDir = entry.type === 'dir'
                const icon = isDir ? '▸' : entry.blocked ? '🔒' : entry.kind === 'image' ? '🖼' : '📄'
                const onClick = isDir ? () => navigate(entry.path) : entry.blocked ? undefined : () => toggleSelect(entry.path, entry.kind === 'image' ? 'image' : 'text')
                return (
                  <button key={entry.path} onClick={onClick} disabled={!isDir && entry.blocked} className={isDir || !entry.blocked ? 'cy-hover-acc' : undefined}
                    style={{ all: 'unset', cursor: onClick ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                      fontSize: 11.5, ...mono, border: `1px solid ${active ? 'var(--acc)' : 'transparent'}`,
                      color: entry.blocked ? 'var(--dim)' : active ? 'var(--ink)' : isDir ? 'var(--ink)' : 'var(--dim)',
                      background: active ? 'var(--bg2)' : 'transparent', opacity: entry.blocked ? 0.5 : 1 }}>
                    <span style={{ color: isDir ? 'var(--acc2)' : 'inherit' }}>{icon}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}{isDir ? '/' : ''}</span>
                    {!isDir && !entry.blocked && <span style={{ marginLeft: 'auto', fontSize: 9, color: active ? 'var(--acc)' : 'var(--dim)' }}>{active ? '✕' : '+'}</span>}
                  </button>
                )
              })}
              {rows.length === 0 && !browseErr && <span style={{ ...mono, fontSize: 11, color: 'var(--dim)', padding: 8 }}>{search.trim() ? 'no matches' : 'empty'}</span>}
            </div>
          </section>
        </aside>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={panel}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>ATTACHED CONTEXT</h2>
              <span style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>{selected.length}/{MAX_ATTACH}{imageCount > 0 ? ` · ${imageCount} img` : ''}</span>
            </div>
            {selected.length === 0 ? (
              <p style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>▸ no files attached — browse and click files to attach</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {selected.map(f => (
                  <span key={f.path} title={f.path} style={{ display: 'flex', alignItems: 'center', gap: 6, ...mono, fontSize: 10, border: `1px solid ${f.kind === 'image' ? 'var(--acc2)' : 'var(--line)'}`, padding: '3px 6px', maxWidth: '100%' }}>
                    <span>{f.kind === 'image' ? '🖼' : '📄'}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    <button onClick={() => setSelected(prev => prev.filter(s => s.path !== f.path))} style={{ all: 'unset', cursor: 'pointer', color: 'var(--bad)' }}>✕</button>
                  </span>
                ))}
              </div>
            )}
            {imageCount > 0 && selectedModel === 'auto' && <p style={{ margin: '10px 0 0', ...mono, fontSize: 10, color: 'var(--acc2)' }}>▸ image attached — AUTO will route to a vision-capable model</p>}
          </div>

          <div style={panel}>
            <label style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>PROMPT</label>
            <textarea className="cy-input" value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runAgent() }} placeholder="▸ task the agent…  (⌘/Ctrl+Enter to run)"
              style={{ width: '100%', boxSizing: 'border-box', minHeight: 130, resize: 'vertical', background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 13, padding: '10px 12px', fontFamily: "'Chakra Petch',sans-serif" }} />
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={runAgent} disabled={!message.trim() || loading} className="cy-btn" style={{ all: 'unset', cursor: 'pointer', fontSize: 13, fontWeight: 700, letterSpacing: 1, padding: '9px 18px', background: 'var(--acc)', color: '#000', border: '1px solid var(--acc)', opacity: !message.trim() || loading ? 0.5 : 1 }}>{loading ? 'RUNNING…' : '▸ RUN AGENT'}</button>
            </div>
            {error && <p style={{ marginTop: 12, fontSize: 12, color: 'var(--bad)', ...mono }}>{error}</p>}
          </div>

          <div style={panel}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>RESPONSE</h2>
              {reply?.meta && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', ...mono, fontSize: 10, color: 'var(--dim)' }}>
                  {reply.meta.platform && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: platformColor(reply.meta.platform) }} />{reply.meta.platform}</span>}
                  {reply.meta.model && <span>· {reply.meta.model}</span>}
                  {reply.meta.taskClass && <span style={{ color: 'var(--acc)' }}>· {reply.meta.taskClass}</span>}
                  {reply.meta.augmented && <span style={{ color: 'var(--acc2)' }}>· web ◉</span>}
                  {reply.meta.latency != null && <span style={{ color: 'var(--acc2)' }}>· {reply.meta.latency}ms</span>}
                  {reply.meta.fallbackAttempts != null && reply.meta.fallbackAttempts > 0 && <span style={{ color: 'var(--warn)' }}>· {reply.meta.fallbackAttempts} fallback{reply.meta.fallbackAttempts > 1 ? 's' : ''}</span>}
                </div>
              )}
            </div>
            {reply?.skipped && <p style={{ margin: '0 0 10px', ...mono, fontSize: 10, color: 'var(--warn)' }}>▸ skipped: {reply.skipped.join(' · ')}</p>}
            {reply ? <ChatMarkdown content={reply.content} /> : <p style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>▸ awaiting task</p>}

            {reply?.meta && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                {/* Thumbs up / down */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button onClick={() => sendFeedback('up')} title="Good response" className="cy-hover-acc"
                    style={{ all: 'unset', cursor: 'pointer', fontSize: 15, padding: '3px 8px', border: `1px solid ${feedback === 'up' ? 'var(--good)' : 'var(--line)'}`, color: feedback === 'up' ? 'var(--good)' : 'var(--dim)' }}>▲</button>
                  <button onClick={() => sendFeedback('down')} title="Bad response (repeated image down-votes demote the model's vision)" className="cy-hover-acc"
                    style={{ all: 'unset', cursor: 'pointer', fontSize: 15, padding: '3px 8px', border: `1px solid ${feedback === 'down' ? 'var(--bad)' : 'var(--line)'}`, color: feedback === 'down' ? 'var(--bad)' : 'var(--dim)' }}>▼</button>
                  {feedback && <span style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>logged</span>}
                </div>
                {/* Save to file */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
                  <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="filename" className="cy-input cy-mono"
                    style={{ background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 11, padding: '6px 8px', width: 130 }} />
                  <select value={saveFormat} onChange={e => setSaveFormat(e.target.value as 'md' | 'txt' | 'pdf')} className="cy-input cy-mono"
                    style={{ background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 11, padding: '6px 8px' }}>
                    <option value="md">.md</option><option value="txt">.txt</option><option value="pdf">.pdf</option>
                  </select>
                  <button onClick={saveOutput} className="cy-hover-acc" style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 11, fontWeight: 700, letterSpacing: 1, border: '1px solid var(--acc)', color: 'var(--acc)', padding: '6px 10px' }}>SAVE</button>
                </div>
                {feedbackNote && <p style={{ margin: 0, flexBasis: '100%', ...mono, fontSize: 10, color: 'var(--warn)' }}>{feedbackNote}</p>}
                {saveMsg && <p style={{ margin: 0, flexBasis: '100%', ...mono, fontSize: 10, color: saveMsg.startsWith('✓') ? 'var(--good)' : 'var(--bad)' }}>{saveMsg}</p>}
              </div>
            )}
          </div>

          {(outputs?.files.length ?? 0) > 0 && (
            <div style={panel}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
                <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>OUTPUT FILES</h2>
                <span style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>{outputs!.files.length} · repo /tmp</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {outputs!.files.map(f => (
                  <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', ...mono, fontSize: 11.5, border: '1px solid transparent' }}>
                    <span style={{ color: 'var(--acc2)' }}>▸</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--dim)' }}>{fmtBytes(f.size)}</span>
                    <button onClick={() => downloadOutput(f.name)} className="cy-hover-acc" style={{ all: 'unset', cursor: 'pointer', fontSize: 10, fontWeight: 700, letterSpacing: 1, border: '1px solid var(--acc)', color: 'var(--acc)', padding: '4px 8px' }}>↓ DOWNLOAD</button>
                    <button onClick={() => deleteOutput(f.name)} title="Delete" style={{ all: 'unset', cursor: 'pointer', fontSize: 12, color: 'var(--bad)', padding: '0 4px' }}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
