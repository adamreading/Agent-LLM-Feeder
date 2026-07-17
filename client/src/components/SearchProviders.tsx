import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const

const initials = (name: string) =>
  name.replace(/[^A-Za-z ]/g, '').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

// Search backends power the Model Wiki's research (street summaries + task
// scores) — NOT chat routing. Distinct from the LLM providers. The provider
// catalog + per-provider key state come from the server (GET /api/settings/search),
// which is the single source of truth (searchConfig.ts SEARCH_PROVIDER_CATALOG).
// Shown on BOTH the Onboarding page and the Key Vault (Adam, 2026-07-11).
interface EngineStats {
  recentLatencyMs: number | null; successCount: number; failCount: number
  callsTotal: number; cooldownUntil: string | null; lastError: string | null
  lastUsedAt: string | null; estSpendUsd: number | null
  quotaLimit: number | null; quotaPeriod: string | null; remaining: number | null
}
interface Provider {
  id: string; name: string; keyed: boolean; tier: string; note: string; paid: boolean
  getUrl: string | null; prefix: string | null
  active: boolean; inPool: boolean; keySet: boolean; keyMasked: string | null
  stats: EngineStats | null
}
interface YouCaps { costPerCall: number; jobCapUsd: number; globalCapUsd: number }
interface SearchState { backend: string; providers: Provider[]; pool: string[]; youCaps: YouCaps }
type SearchBody = { activate?: string; setKey?: { backend: string; key: string }; clearKey?: string; pool?: { backend: string; action: 'add' | 'remove' } }
type VerifyOutcome = { state: 'ok' | 'fail'; msg: string }

export default function SearchProviders() {
  const queryClient = useQueryClient()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [verify, setVerify] = useState<Record<string, VerifyOutcome | 'pending'>>({})
  const { data } = useQuery<SearchState>({ queryKey: ['search-config'], queryFn: () => apiFetch('/api/settings/search') })

  const setDraft = (id: string, v: string) => setDrafts(d => ({ ...d, [id]: v }))

  const mutate = useMutation({
    mutationFn: (body: SearchBody) => apiFetch('/api/settings/search', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['search-config'] }),
  })

  const runVerify = async (id: string, key?: string) => {
    setVerify(v => ({ ...v, [id]: 'pending' }))
    try {
      const r = await apiFetch<{ ok: boolean; count?: number; error?: string }>(
        '/api/settings/search/verify', { method: 'POST', body: JSON.stringify({ backend: id, key }) })
      setVerify(v => ({ ...v, [id]: r.ok ? { state: 'ok', msg: `OK · ${r.count ?? 0} result${r.count === 1 ? '' : 's'}` } : { state: 'fail', msg: r.error || 'failed' } }))
    } catch (e) {
      setVerify(v => ({ ...v, [id]: { state: 'fail', msg: String((e as Error)?.message ?? e).slice(0, 120) } }))
    }
  }

  const providers = data?.providers ?? []
  return (
    <div style={{ marginTop: 40 }}>
      <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// RESEARCH FEED</div>
      <h2 style={{ margin: '0 0 4px', fontSize: 26, fontWeight: 700, letterSpacing: 1 }}>SEARCH PROVIDERS</h2>
      <p style={{ margin: '0 0 16px', color: 'var(--dim)', fontSize: 13, maxWidth: 680 }}>
        Powers web-search augment + the Model Wiki's research. Not used for chat. Keys are stored encrypted in the database (never in <code>.env</code>). Add a key, VERIFY it, then <strong>add engines to the BANK</strong> — search load spreads evenly across the activated free engines so none gets rate-limited, with per-engine latency tracked below. <strong>You.com is the paid last-resort</strong> (fires only when every free engine is exhausted; guarded by a ${data?.youCaps?.jobCapUsd ?? 5}/job + ${data?.youCaps?.globalCapUsd ?? 180} global spend cap).
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', gap: 14 }}>
        {providers.map(p => {
          const draft = drafts[p.id] ?? ''
          const hasKey = p.keySet
          const editing = draft.trim().length > 0
          const v = verify[p.id]
          const inBank = p.inPool
          const cardBorder = inBank ? (p.paid ? 'rgba(255,193,61,.5)' : 'rgba(61,255,160,.45)') : 'var(--line)'
          const canAdd = !inBank && (!p.keyed || hasKey)
          const cooling = !!p.stats?.cooldownUntil && new Date(p.stats.cooldownUntil).getTime() > Date.now()
          const st = p.stats
          return (
            <div key={p.id} className="cy-hover-acc" style={{ border: `1px solid ${cardBorder}`, background: 'var(--panel)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, position: 'relative' }}>
              <div style={{ position: 'absolute', top: 0, right: 0, width: 14, height: 14, background: `linear-gradient(135deg, transparent 50%, ${cardBorder} 50%)` }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 32, height: 32, border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, color: 'var(--acc)', background: 'var(--bg2)' }}>{initials(p.name)}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, letterSpacing: '.5px' }}>{p.name}</div>
                  <div style={{ ...mono, fontSize: 9.5, color: 'var(--dim)', letterSpacing: '.5px' }}>{p.tier}</div>
                </div>
                {inBank && <span style={{ ...mono, fontSize: 9, letterSpacing: 1, color: p.paid ? 'var(--warn, #ffc13d)' : 'var(--good)', border: `1px solid ${p.paid ? 'var(--warn, #ffc13d)' : 'var(--good)'}`, padding: '3px 6px' }}>{p.paid ? '◈ FALLBACK' : '◈ IN BANK'}</span>}
              </div>
              <p style={{ ...mono, fontSize: 10.5, color: 'var(--dim)', lineHeight: 1.5, margin: 0, minHeight: 44 }}>{p.note}</p>

              {st && (st.callsTotal > 0 || st.recentLatencyMs != null) && (
                <div style={{ ...mono, fontSize: 9.5, letterSpacing: '.3px', color: cooling ? 'var(--bad, #ff6b6b)' : 'var(--dim)', lineHeight: 1.5, borderTop: '1px solid var(--line)', paddingTop: 6 }}>
                  {st.recentLatencyMs != null && <span>⚡ {st.recentLatencyMs}ms  </span>}
                  <span>✓ {st.successCount}/{st.successCount + st.failCount}  </span>
                  {st.quotaLimit != null && st.remaining != null && (
                    <span style={{ color: st.remaining / st.quotaLimit < 0.15 ? 'var(--warn, #ffc13d)' : 'inherit' }}>
                      · {st.remaining}/{st.quotaLimit} left{st.quotaPeriod === 'month' ? '/mo' : ''}  </span>
                  )}
                  {p.paid && st.estSpendUsd != null && <span style={{ color: 'var(--warn, #ffc13d)' }}>· ${st.estSpendUsd.toFixed(2)}/${data?.youCaps?.globalCapUsd ?? 180}  </span>}
                  {cooling && <span>· COOLING DOWN</span>}
                </div>
              )}

              {p.keyed && (
                <>
                  {p.getUrl && (
                    <a href={p.getUrl} target="_blank" rel="noreferrer" className="cy-hover-acc2" style={{ textAlign: 'center', fontSize: 11, fontWeight: 600, letterSpacing: 1, border: '1px solid var(--line)', padding: '7px 0', color: 'var(--ink)' }}>GET KEY ⧉</a>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      className="cy-input"
                      value={editing ? draft : (hasKey ? (p.keyMasked ?? '') : '')}
                      onChange={e => setDraft(p.id, e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && draft.trim()) mutate.mutate({ setKey: { backend: p.id, key: draft.trim() } }, { onSuccess: () => setDraft(p.id, '') }) }}
                      placeholder={p.prefix ?? 'api key'}
                      disabled={hasKey && !editing}
                      style={{ flex: 1, minWidth: 0, background: 'var(--bg2)', border: '1px solid var(--line)', color: hasKey && !editing ? 'var(--dim)' : 'var(--ink)', fontSize: 12, padding: '8px 10px', ...mono }}
                    />
                    <button onClick={() => draft.trim() && mutate.mutate({ setKey: { backend: p.id, key: draft.trim() } }, { onSuccess: () => setDraft(p.id, '') })} disabled={mutate.isPending || !draft.trim()} className="cy-btn" style={{
                      all: 'unset', cursor: draft.trim() ? 'pointer' : 'default', fontSize: 12, fontWeight: 700, letterSpacing: 1, padding: '8px 14px',
                      background: 'var(--acc)', color: '#000', border: '1px solid var(--acc)', opacity: draft.trim() ? 1 : 0.5,
                    }}>{hasKey ? 'REPLACE' : 'SAVE'}</button>
                  </div>
                  {(hasKey || editing) && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <button onClick={() => runVerify(p.id, draft.trim() || undefined)} disabled={v === 'pending'} className="cy-hover-acc" style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 9, letterSpacing: 1, color: 'var(--acc2)', border: '1px solid var(--line)', padding: '2px 8px' }}>{v === 'pending' ? 'VERIFYING…' : 'VERIFY'}</button>
                      {hasKey && <span style={{ ...mono, fontSize: 9, letterSpacing: 1, color: 'var(--good)' }}>◈ KEY LINKED</span>}
                      {hasKey && <button onClick={() => mutate.mutate({ clearKey: p.id })} className="cy-hover-acc" style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 9, letterSpacing: 1, color: 'var(--dim)', border: '1px solid var(--line)', padding: '2px 6px' }}>REMOVE</button>}
                    </div>
                  )}
                  {v && v !== 'pending' && (
                    <div style={{ ...mono, fontSize: 9.5, letterSpacing: '.5px', color: v.state === 'ok' ? 'var(--good)' : 'var(--bad, #ff6b6b)', lineHeight: 1.4 }}>
                      {v.state === 'ok' ? '✓ ' : '✗ '}{v.msg}
                    </div>
                  )}
                </>
              )}

              <button
                onClick={() => mutate.mutate({ pool: { backend: p.id, action: inBank ? 'remove' : 'add' } })}
                disabled={(!canAdd && !inBank) || mutate.isPending}
                className="cy-btn"
                style={{
                  all: 'unset', textAlign: 'center', cursor: (canAdd || inBank) ? 'pointer' : 'default',
                  fontSize: 11, fontWeight: 700, letterSpacing: 1, padding: '8px 0',
                  border: `1px solid ${inBank ? 'var(--dim)' : 'var(--acc)'}`,
                  color: inBank ? 'var(--dim)' : (canAdd ? 'var(--acc)' : 'var(--dim)'),
                  background: 'transparent', opacity: (!canAdd && !inBank) ? 0.5 : 1,
                }}
              >{inBank ? 'REMOVE FROM BANK' : (p.keyed && !hasKey ? 'ADD KEY FIRST' : 'ADD TO BANK')}</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
