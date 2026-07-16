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
interface Provider {
  id: string; name: string; keyed: boolean; tier: string; note: string
  getUrl: string | null; prefix: string | null
  active: boolean; keySet: boolean; keyMasked: string | null
}
interface SearchState { backend: string; providers: Provider[] }
type SearchBody = { activate?: string; setKey?: { backend: string; key: string }; clearKey?: string }
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
      <p style={{ margin: '0 0 16px', color: 'var(--dim)', fontSize: 13, maxWidth: 640 }}>
        Powers the Model Wiki's street-research — web summaries + task scores per model. Not used for chat. Keys are stored encrypted in the database (never in <code>.env</code>). Add a key, VERIFY it with one live query, then pick which backend is active.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', gap: 14 }}>
        {providers.map(p => {
          const draft = drafts[p.id] ?? ''
          const hasKey = p.keySet
          const editing = draft.trim().length > 0
          const v = verify[p.id]
          const cardBorder = p.active ? 'rgba(61,255,160,.45)' : 'var(--line)'
          const canActivate = !p.active && (!p.keyed || hasKey)
          return (
            <div key={p.id} className="cy-hover-acc" style={{ border: `1px solid ${cardBorder}`, background: 'var(--panel)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, position: 'relative' }}>
              <div style={{ position: 'absolute', top: 0, right: 0, width: 14, height: 14, background: `linear-gradient(135deg, transparent 50%, ${cardBorder} 50%)` }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 32, height: 32, border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, color: 'var(--acc)', background: 'var(--bg2)' }}>{initials(p.name)}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, letterSpacing: '.5px' }}>{p.name}</div>
                  <div style={{ ...mono, fontSize: 9.5, color: 'var(--dim)', letterSpacing: '.5px' }}>{p.tier}</div>
                </div>
                {p.active && <span style={{ ...mono, fontSize: 9, letterSpacing: 1, color: 'var(--good)', border: '1px solid var(--good)', padding: '3px 6px', boxShadow: '0 0 8px rgba(61,255,160,.25)' }}>◈ ACTIVE</span>}
              </div>
              <p style={{ ...mono, fontSize: 10.5, color: 'var(--dim)', lineHeight: 1.5, margin: 0, minHeight: 44 }}>{p.note}</p>

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
                onClick={() => mutate.mutate({ activate: p.id })}
                disabled={!canActivate || mutate.isPending}
                className="cy-btn"
                style={{
                  all: 'unset', textAlign: 'center', cursor: canActivate ? 'pointer' : 'default',
                  fontSize: 11, fontWeight: 700, letterSpacing: 1, padding: '8px 0',
                  border: `1px solid ${p.active ? 'var(--good)' : 'var(--acc)'}`,
                  color: p.active ? 'var(--good)' : (canActivate ? 'var(--acc)' : 'var(--dim)'),
                  background: 'transparent', opacity: (!canActivate && !p.active) ? 0.5 : 1,
                }}
              >{p.active ? 'IN USE' : (p.keyed && !hasKey ? 'ADD KEY TO USE' : 'USE THIS')}</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
