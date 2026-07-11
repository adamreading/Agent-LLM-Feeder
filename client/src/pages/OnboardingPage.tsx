import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import SearchProviders from '@/components/SearchProviders'
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
  { id: 'opencode', name: 'OpenCode Zen', tier: '5 FREE ROUTES', prefix: 'sk-…', accountUrl: 'https://opencode.ai/zen', keyUrl: 'https://opencode.ai/zen' },
]

const initials = (name: string) =>
  name.replace(/[^A-Za-z ]/g, '').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

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
