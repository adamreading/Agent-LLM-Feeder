import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { ApiKey, Platform } from '../../../shared/types'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const

// Provider metadata from the design handoff — name / free-tier label / key
// prefix / account + key URLs. Wired to the real /api/keys endpoint.
const PROVIDERS: { id: Platform; name: string; tier: string; prefix: string; accountUrl: string; keyUrl: string }[] = [
  { id: 'google', name: 'Google AI Studio', tier: 'GEMINI FREE TIER', prefix: 'AIza…', accountUrl: 'https://ai.google.dev', keyUrl: 'https://aistudio.google.com/api-keys' },
  { id: 'groq', name: 'Groq', tier: 'FREE DEV QUOTA', prefix: 'gsk_…', accountUrl: 'https://console.groq.com', keyUrl: 'https://console.groq.com/keys' },
  { id: 'cerebras', name: 'Cerebras', tier: 'FREE INFERENCE TIER', prefix: 'csk-…', accountUrl: 'https://cloud.cerebras.ai', keyUrl: 'https://cloud.cerebras.ai/platform' },
  { id: 'sambanova', name: 'SambaNova', tier: 'FREE CLOUD ACCESS', prefix: 'sn-…', accountUrl: 'https://cloud.sambanova.ai', keyUrl: 'https://cloud.sambanova.ai/apis' },
  { id: 'nvidia', name: 'NVIDIA NIM', tier: 'DEV TRIAL CREDITS', prefix: 'nvapi-…', accountUrl: 'https://build.nvidia.com', keyUrl: 'https://build.nvidia.com' },
  { id: 'mistral', name: 'Mistral', tier: 'LA PLATEFORME FREE', prefix: 'mst-…', accountUrl: 'https://console.mistral.ai', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'openrouter', name: 'OpenRouter', tier: 'FREE MODELS POOL', prefix: 'sk-or-…', accountUrl: 'https://openrouter.ai', keyUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'github', name: 'GitHub Models', tier: 'PAT FREE TIER', prefix: 'ghp_…', accountUrl: 'https://github.com/marketplace/models', keyUrl: 'https://github.com/settings/personal-access-tokens' },
  { id: 'cohere', name: 'Cohere', tier: 'TRIAL KEY', prefix: 'co-…', accountUrl: 'https://dashboard.cohere.com', keyUrl: 'https://dashboard.cohere.com/api-keys' },
  { id: 'cloudflare', name: 'Cloudflare Workers AI', tier: '10K NEURONS / DAY', prefix: 'cf-…', accountUrl: 'https://dash.cloudflare.com', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens' },
  { id: 'zhipu', name: 'Z.ai / Zhipu', tier: 'FREE GLM TIER', prefix: 'zk-…', accountUrl: 'https://bigmodel.cn', keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys' },
  { id: 'ollama', name: 'Ollama Cloud', tier: 'HOBBY TIER', prefix: 'ol-…', accountUrl: 'https://ollama.com', keyUrl: 'https://ollama.com/settings/keys' },
  { id: 'kilo', name: 'Kilo Gateway', tier: 'GATEWAY FREE', prefix: 'kg-…', accountUrl: 'https://kilo.ai', keyUrl: 'https://kilo.ai' },
  { id: 'pollinations', name: 'Pollinations', tier: 'ANONYMOUS OK', prefix: 'token…', accountUrl: 'https://pollinations.ai', keyUrl: 'https://pollinations.ai' },
  { id: 'llm7', name: 'LLM7', tier: 'COMMUNITY FREE', prefix: 'llm7-…', accountUrl: 'https://llm7.io', keyUrl: 'https://llm7.io' },
]

const initials = (name: string) =>
  name.replace(/[^A-Za-z ]/g, '').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

// Search backends power the Model Wiki's research (street summaries + task
// scores) — NOT chat routing. Distinct from LLM providers above.
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

function SearchProviders() {
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
      <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// STEP 02 — RESEARCH FEED</div>
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

export default function OnboardingPage() {
  const queryClient = useQueryClient()
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const { data: keys = [] } = useQuery<ApiKey[]>({ queryKey: ['keys'], queryFn: () => apiFetch('/api/keys') })

  const addKey = useMutation({
    mutationFn: (body: { platform: Platform; key: string; label?: string }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const connected = new Set(keys.map(k => k.platform))
  const connectedCount = connected.size
  const total = PROVIDERS.length
  const pct = Math.round((connectedCount / total) * 100)
  const progressMsg = connectedCount === 0 ? '> insert first key to boot the router'
    : connectedCount < 4 ? '> router live. more keys = more fallback lives'
    : '> solid chain. the router will not go hungry'

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '36px 28px 80px', animation: 'flickin .35s ease' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// STEP 01 — JACK IN</div>
          <h1 style={{ margin: 0, fontSize: 40, fontWeight: 700, letterSpacing: 1, textShadow: '0 0 24px var(--glow)' }}>ONBOARDING</h1>
          <p style={{ margin: '8px 0 0', color: 'var(--dim)', fontSize: 14, maxWidth: 560 }}>
            Grab free-tier keys from the grid below. One key lights up the router — every extra key is another life when a provider rate-limits you.
          </p>
        </div>
        <div style={{ flex: 1, minWidth: 260, border: '1px solid var(--line)', background: 'var(--panel)', padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', ...mono, fontSize: 11, color: 'var(--dim)', marginBottom: 8 }}>
            <span>PROVIDERS CONNECTED</span><span style={{ color: 'var(--acc2)' }}>{connectedCount} / {total}</span>
          </div>
          <div style={{ height: 10, border: '1px solid var(--line)', padding: 1 }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'repeating-linear-gradient(90deg, var(--acc) 0px, var(--acc) 6px, transparent 6px, transparent 9px)', boxShadow: '0 0 10px var(--glow)', transition: 'width .4s' }} />
          </div>
          <div style={{ marginTop: 8, ...mono, fontSize: 10, color: 'var(--dim)' }}>{progressMsg}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', gap: 14, marginTop: 24 }}>
        {PROVIDERS.map(p => {
          const isOn = connected.has(p.id)
          const cardBorder = isOn ? 'rgba(61,255,160,.45)' : 'var(--line)'
          const draft = drafts[p.id] || ''
          const submit = () => {
            if (!draft.trim()) return
            addKey.mutate({ platform: p.id, key: draft.trim(), label: 'onboarding' })
            setDrafts(s => ({ ...s, [p.id]: '' }))
          }
          return (
            <div key={p.id} className="cy-hover-acc" style={{ border: `1px solid ${cardBorder}`, background: 'var(--panel)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, position: 'relative' }}>
              <div style={{ position: 'absolute', top: 0, right: 0, width: 14, height: 14, background: `linear-gradient(135deg, transparent 50%, ${cardBorder} 50%)` }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 32, height: 32, border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, color: 'var(--acc)', background: 'var(--bg2)' }}>{initials(p.name)}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, letterSpacing: '.5px' }}>{p.name}</div>
                  <div style={{ ...mono, fontSize: 9.5, color: 'var(--dim)', letterSpacing: '.5px' }}>{p.tier}</div>
                </div>
                {isOn && <span style={{ ...mono, fontSize: 9, letterSpacing: 1, color: 'var(--good)', border: '1px solid var(--good)', padding: '3px 6px', boxShadow: '0 0 8px rgba(61,255,160,.25)' }}>◈ LINKED</span>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <a href={p.accountUrl} target="_blank" rel="noreferrer" className="cy-hover-acc2" style={{ flex: 1, textAlign: 'center', fontSize: 11, fontWeight: 600, letterSpacing: 1, border: '1px solid var(--line)', padding: '7px 0', color: 'var(--ink)' }}>ACCOUNT ⧉</a>
                <a href={p.keyUrl} target="_blank" rel="noreferrer" className="cy-hover-acc2" style={{ flex: 1, textAlign: 'center', fontSize: 11, fontWeight: 600, letterSpacing: 1, border: '1px solid var(--line)', padding: '7px 0', color: 'var(--ink)' }}>GET KEY ⧉</a>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="cy-input"
                  value={draft}
                  onChange={e => setDrafts(s => ({ ...s, [p.id]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') submit() }}
                  placeholder={p.prefix}
                  style={{ flex: 1, minWidth: 0, background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 12, padding: '8px 10px', ...mono }}
                />
                <button onClick={submit} disabled={addKey.isPending} className="cy-btn" style={{
                  all: 'unset', cursor: 'pointer', fontSize: 12, fontWeight: 700, letterSpacing: 1, padding: '8px 14px',
                  background: isOn ? 'transparent' : 'var(--acc)', color: isOn ? 'var(--acc)' : '#000', border: '1px solid var(--acc)',
                }}>{isOn ? '+ MORE' : 'PLUG IN'}</button>
              </div>
            </div>
          )
        })}
      </div>

      <SearchProviders />
    </main>
  )
}
