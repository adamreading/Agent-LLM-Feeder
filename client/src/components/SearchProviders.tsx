import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const

const initials = (name: string) =>
  name.replace(/[^A-Za-z ]/g, '').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

// Search backends power the Model Wiki's research (street summaries + task
// scores) — NOT chat routing. Distinct from the LLM providers. Shown on BOTH
// the Onboarding page and the Key Vault so search keys are managed alongside
// provider keys (Adam, 2026-07-11).
const SEARCH_PROVIDERS: {
  id: string; name: string; tier: string; keyed: boolean; prefix?: string;
  getUrl?: string; note: string; managedElsewhere?: boolean;
}[] = [
  { id: 'tavily', name: 'Tavily', tier: 'FREE · 1K SEARCHES / MO', keyed: true, prefix: 'tvly-…', getUrl: 'https://tavily.com', note: 'Search + page content in one call, built for LLM research. Reliable primary — keyed, so no IP blocking.' },
  { id: 'ddg', name: 'DuckDuckGo', tier: 'KEYLESS', keyed: false, note: 'Free, no key. Fine for light use, but DDG IP-blocks sustained scraping — unreliable as a heavy primary from datacenter/WSL egress.' },
  { id: 'ollama', name: 'Ollama Web Search', tier: 'FREE · HOURLY + WEEKLY CAPS', keyed: false, managedElsewhere: true, note: 'Hosted search + fetch (uses your Ollama provider key). Reliable but the free tier throttles hard under a big populate.' },
]

interface SearchState {
  backend: string
  available: string[]
  keyed: string[]
  keys: Record<string, { set: boolean; masked: string | null }>
}

export default function SearchProviders() {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const { data } = useQuery<SearchState>({ queryKey: ['search-config'], queryFn: () => apiFetch('/api/settings/search') })

  const mutate = useMutation({
    mutationFn: (body: { backend?: string; tavily_key?: string; clear?: string }) =>
      apiFetch('/api/settings/search', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['search-config'] })
      setDraft('')
    },
  })

  const active = data?.backend
  return (
    <div style={{ marginTop: 40 }}>
      <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// RESEARCH FEED</div>
      <h2 style={{ margin: '0 0 4px', fontSize: 26, fontWeight: 700, letterSpacing: 1 }}>SEARCH PROVIDERS</h2>
      <p style={{ margin: '0 0 16px', color: 'var(--dim)', fontSize: 13, maxWidth: 620 }}>
        Powers the Model Wiki's street-research — web summaries + task scores per model. Not used for chat. Pick one backend; keyed providers are the most reliable for a full catalog sweep.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', gap: 14 }}>
        {SEARCH_PROVIDERS.map(p => {
          const isActive = active === p.id
          const keyState = data?.keys?.[p.id]
          const hasKey = keyState?.set ?? false
          const cardBorder = isActive ? 'rgba(61,255,160,.45)' : 'var(--line)'
          return (
            <div key={p.id} className="cy-hover-acc" style={{ border: `1px solid ${cardBorder}`, background: 'var(--panel)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, position: 'relative' }}>
              <div style={{ position: 'absolute', top: 0, right: 0, width: 14, height: 14, background: `linear-gradient(135deg, transparent 50%, ${cardBorder} 50%)` }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 32, height: 32, border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, color: 'var(--acc)', background: 'var(--bg2)' }}>{initials(p.name)}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, letterSpacing: '.5px' }}>{p.name}</div>
                  <div style={{ ...mono, fontSize: 9.5, color: 'var(--dim)', letterSpacing: '.5px' }}>{p.tier}</div>
                </div>
                {isActive && <span style={{ ...mono, fontSize: 9, letterSpacing: 1, color: 'var(--good)', border: '1px solid var(--good)', padding: '3px 6px', boxShadow: '0 0 8px rgba(61,255,160,.25)' }}>◈ ACTIVE</span>}
              </div>
              <p style={{ ...mono, fontSize: 10.5, color: 'var(--dim)', lineHeight: 1.5, margin: 0, minHeight: 44 }}>{p.note}</p>

              {p.keyed && (
                <>
                  {p.getUrl && (
                    <a href={p.getUrl} target="_blank" rel="noreferrer" className="cy-hover-acc2" style={{ textAlign: 'center', fontSize: 11, fontWeight: 600, letterSpacing: 1, border: '1px solid var(--line)', padding: '7px 0', color: 'var(--ink)' }}>GET FREE KEY ⧉</a>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      className="cy-input"
                      value={draft && !hasKey ? draft : (hasKey ? (keyState?.masked ?? '') : draft)}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && draft.trim()) mutate.mutate({ tavily_key: draft.trim() }) }}
                      placeholder={p.prefix}
                      disabled={hasKey && !draft}
                      style={{ flex: 1, minWidth: 0, background: 'var(--bg2)', border: '1px solid var(--line)', color: hasKey && !draft ? 'var(--dim)' : 'var(--ink)', fontSize: 12, padding: '8px 10px', ...mono }}
                    />
                    <button onClick={() => draft.trim() && mutate.mutate({ tavily_key: draft.trim() })} disabled={mutate.isPending || !draft.trim()} className="cy-btn" style={{
                      all: 'unset', cursor: draft.trim() ? 'pointer' : 'default', fontSize: 12, fontWeight: 700, letterSpacing: 1, padding: '8px 14px',
                      background: 'var(--acc)', color: '#000', border: '1px solid var(--acc)', opacity: draft.trim() ? 1 : 0.5,
                    }}>{hasKey ? 'REPLACE' : 'SAVE KEY'}</button>
                  </div>
                  {hasKey && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ ...mono, fontSize: 9, letterSpacing: 1, color: 'var(--good)' }}>◈ KEY LINKED</span>
                      <button onClick={() => mutate.mutate({ clear: p.id as 'tavily' })} className="cy-hover-acc" style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 9, letterSpacing: 1, color: 'var(--dim)', border: '1px solid var(--line)', padding: '2px 6px' }}>REMOVE</button>
                    </div>
                  )}
                </>
              )}
              {p.managedElsewhere && (
                <div style={{ ...mono, fontSize: 9, color: 'var(--dim)', letterSpacing: '.5px' }}>KEY: via the Ollama provider above</div>
              )}

              <button
                onClick={() => mutate.mutate({ backend: p.id })}
                disabled={isActive || mutate.isPending || (p.keyed && !hasKey)}
                className="cy-btn"
                style={{
                  all: 'unset', textAlign: 'center', cursor: isActive || (p.keyed && !hasKey) ? 'default' : 'pointer',
                  fontSize: 11, fontWeight: 700, letterSpacing: 1, padding: '8px 0',
                  border: `1px solid ${isActive ? 'var(--good)' : 'var(--acc)'}`,
                  color: isActive ? 'var(--good)' : (p.keyed && !hasKey ? 'var(--dim)' : 'var(--acc)'),
                  background: 'transparent', opacity: (p.keyed && !hasKey && !isActive) ? 0.5 : 1,
                }}
              >{isActive ? 'IN USE' : (p.keyed && !hasKey ? 'ADD KEY TO USE' : 'USE THIS')}</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
