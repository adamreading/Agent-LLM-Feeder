import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '@/lib/api'
import {
  type CanonModel, capLabel, makerFromName, prettyCtx,
  bestIntel, maxCtx, wikiCaps, hasModality, overallScore, researchScore, hasRealtimeQuality,
} from '@/lib/cyber'

const FILTERS = [
  { id: 'all', label: 'ALL' },
  { id: 'tools', label: 'TOOL CALLS' },
  { id: 'vision', label: 'VISION' },
  { id: 'audio', label: 'AUDIO' },
  { id: 'video', label: 'VIDEO' },
  { id: 'json_mode', label: 'JSON' },
  { id: 'long_context', label: 'LONG CTX' },
]

const label = { fontFamily: "'JetBrains Mono',monospace" } as const

interface ResearchStatus {
  running: boolean; total: number; done: number; empty: number; failed: number
  remaining: number; rateLimited: boolean; lastError: string | null; current: string | null
}

// "RESEARCH MISSING" — runs street-research for every model that still has no
// summary, in one background pass on the server. Polls progress while running
// and refreshes the wiki cards as summaries land. Stops cleanly on the search
// backend's hourly cap; click again later to fill the rest.
function ResearchMissing() {
  const qc = useQueryClient()
  const [msg, setMsg] = useState<string | null>(null)
  const prevDone = useRef(0)

  const { data: status } = useQuery<ResearchStatus>({
    queryKey: ['research-status'],
    queryFn: () => apiFetch('/api/canon/research-status'),
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  })

  // Refresh the model cards as new summaries are written mid-pass.
  useEffect(() => {
    if (status && status.done !== prevDone.current) {
      prevDone.current = status.done
      qc.invalidateQueries({ queryKey: ['canon'] })
    }
  }, [status?.done, qc])

  const running = status?.running ?? false
  const remaining = status?.remaining ?? 0

  async function trigger() {
    setMsg(null)
    const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/canon/research-missing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok && body.reason) setMsg(body.reason)
    qc.invalidateQueries({ queryKey: ['research-status'] })
  }

  let text: string
  if (running) text = `▸ RESEARCHING ${status!.done + status!.empty + status!.failed}/${status!.total}…`
  else if (remaining === 0) text = 'ALL MODELS RESEARCHED ✓'
  else text = `⟳ RESEARCH MISSING (${remaining})`

  const disabled = running || remaining === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button onClick={trigger} disabled={disabled} className="cy-hover-acc" style={{
        all: 'unset', cursor: disabled ? 'default' : 'pointer', ...label, fontSize: 10.5, fontWeight: 700, letterSpacing: 1,
        padding: '8px 14px', border: `1px solid ${remaining === 0 ? 'var(--good)' : 'var(--acc)'}`,
        color: remaining === 0 ? 'var(--good)' : (running ? 'var(--dim)' : 'var(--acc)'),
        background: 'transparent', opacity: running ? 0.8 : 1,
      }}>{text}</button>
      {running && status?.current && (
        <span style={{ ...label, fontSize: 9, color: 'var(--dim)' }}>▸ {status.current}</span>
      )}
      {status?.rateLimited && !running && (
        <span style={{ ...label, fontSize: 9, color: 'var(--warn, #e0a030)' }}>SEARCH RATE-LIMITED — RETRY LATER</span>
      )}
      {msg && <span style={{ ...label, fontSize: 9, color: 'var(--dim)', maxWidth: 260, textAlign: 'right' }}>{msg}</span>}
    </div>
  )
}

export default function ModelWikiPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')

  const { data: models = [], isLoading } = useQuery<CanonModel[]>({
    queryKey: ['canon'],
    queryFn: () => apiFetch('/api/canon'),
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    // Dynamic, research-driven order: models with research scores rank first
    // (highest score = top), un-researched fall to the bottom ordered by the
    // static intelligence_rank as a fallback tiebreak.
    let list = [...models].sort((a, b) => {
      const ra = researchScore(a), rb = researchScore(b)
      if (ra != null && rb != null) return rb - ra
      if (ra != null) return -1
      if (rb != null) return 1
      return (bestIntel(a) ?? 99) - (bestIntel(b) ?? 99)
    })
    if (filter === 'vision' || filter === 'audio' || filter === 'video') list = list.filter(m => hasModality(m, filter))
    else if (filter !== 'all') list = list.filter(m => m.capabilities.some(c => c.capability === filter && c.supported))
    if (q) list = list.filter(m =>
      (m.name + ' ' + makerFromName(m.name) + ' ' + m.slug).toLowerCase().includes(q) ||
      m.instances.some(i => i.platform.toLowerCase().includes(q) || i.model_id.toLowerCase().includes(q)))
    return list
  }, [models, search, filter])

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '36px 28px 80px', animation: 'flickin .35s ease' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ ...label, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// THE STREET KNOWS ITS MODELS</div>
          <h1 style={{ margin: '0 0 6px', fontSize: 40, fontWeight: 700, letterSpacing: 1, textShadow: '0 0 24px var(--glow)' }}>MODEL WIKI</h1>
          <p style={{ margin: '0 0 20px', color: 'var(--dim)', fontSize: 14, maxWidth: 620 }}>
            Every model in the catalog, what it's actually good at, and how each free-tier provider serves it. Grouped across suppliers, with live probe data.
          </p>
        </div>
        <ResearchMissing />
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <input
          className="cy-input cy-mono"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="▸ search models, makers, capabilities…"
          style={{ flex: 1, minWidth: 280, background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 14, padding: '12px 14px', letterSpacing: '.5px' }}
        />
        <span style={{ ...label, fontSize: 11, color: 'var(--dim)' }}>{filtered.length} INDEXED</span>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 22 }}>
        {FILTERS.map(f => {
          const active = filter === f.id
          return (
            <button key={f.id} onClick={() => setFilter(f.id)} className="cy-hover-acc" style={{
              all: 'unset', cursor: 'pointer', ...label, fontSize: 10.5, fontWeight: 700, letterSpacing: 1,
              padding: '6px 12px', border: `1px solid ${active ? 'var(--acc)' : 'var(--line)'}`,
              color: active ? '#000' : 'var(--dim)', background: active ? 'var(--acc)' : 'transparent',
            }}>{f.label}</button>
          )
        })}
      </div>

      {isLoading ? (
        <p className="cy-mono" style={{ color: 'var(--dim)', fontSize: 12 }}>▸ indexing catalog…</p>
      ) : filtered.length === 0 ? (
        <div style={{ border: '1px dashed var(--line)', padding: 40, textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>
          {models.length === 0 ? 'No canonical models yet — they appear once matched across suppliers.' : 'No models match.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(350px,1fr))', gap: 14 }}>
          {filtered.map(m => {
            const intel = bestIntel(m)
            const caps = wikiCaps(m).slice(0, 6)
            const overall = overallScore(m)
            const research = researchScore(m)          // overall, else task mean
            const barLabel = overall != null ? 'ARENA SCORE' : (research != null ? 'RESEARCH SCORE' : 'ARENA SCORE')
            const platforms = [...new Set(m.instances.map(i => i.platform))]
            const hostLine = `${m.instances.length} FREE HOST${m.instances.length === 1 ? '' : 'S'} · ${platforms.slice(0, 3).map(p => p.toUpperCase()).join(' / ')}`
            return (
              <div key={m.id} onClick={() => navigate(`/wiki/${m.slug}`)} className="cy-hover-glow" style={{
                cursor: 'pointer', border: '1px solid var(--line)', background: 'var(--panel)', padding: 16,
                display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: '.5px' }}>{m.name.toUpperCase()}</div>
                    <div style={{ ...label, fontSize: 10, color: 'var(--dim)', letterSpacing: '.5px', marginTop: 2 }}>
                      {makerFromName(m.name).toUpperCase()} · {(m.instances[0]?.size_label ?? '—').toUpperCase()} · CTX {prettyCtx(maxCtx(m))}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ ...label, fontSize: 10, color: 'var(--dim)' }}>INTEL</div>
                    <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--acc2)', textShadow: '0 0 10px var(--acc2)' }}>{intel != null ? `#${intel}` : '—'}</div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', minHeight: 18 }}>
                  {caps.map(c => (
                    <span key={c.cap} title={c.declared ? 'declared by research (not wire-measured)' : 'wire-measured'} style={{ ...label, fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: '3px 6px', border: `1px solid ${c.declared ? 'var(--acc2)' : 'var(--acc)'}`, color: c.declared ? 'var(--acc2)' : 'var(--acc)', opacity: c.declared ? 0.85 : 1 }}>
                      {capLabel(c.cap)}{c.declared ? '≈' : ''}
                    </span>
                  ))}
                  {caps.length === 0 && <span style={{ ...label, fontSize: 9, color: 'var(--dim)' }}>NO CAPS YET</span>}
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', ...label, fontSize: 9.5, color: 'var(--dim)', marginBottom: 4 }}>
                    <span>{barLabel}{hasRealtimeQuality(m) && <span title="Rating is evolving from real-usage quality" style={{ marginLeft: 6, color: 'var(--acc2)', fontSize: 8.5, fontWeight: 700 }}>◆ LIVE</span>}</span>
                    <span style={{ color: 'var(--ink)' }}>{research != null ? Math.round(research * 100) : 'PENDING'}</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--bg2)', border: '1px solid var(--line)' }}>
                    <div style={{ height: '100%', width: `${research != null ? Math.round(research * 100) : 0}%`, background: 'linear-gradient(90deg, var(--acc), var(--acc2))', boxShadow: '0 0 8px var(--glow)' }} />
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', ...label, fontSize: 10, color: 'var(--dim)' }}>
                  <span>{hostLine}</span>
                  <span style={{ color: 'var(--acc)' }}>OPEN FILE ▸</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
