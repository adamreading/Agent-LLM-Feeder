import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { PLATFORM_IDS, platformName, platformColor } from '@/lib/cyber'
import SearchProviders from '@/components/SearchProviders'
import type { ApiKey } from '../../../shared/types'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const

const STATUS: Record<string, { label: string; color: string }> = {
  healthy: { label: 'HEALTHY', color: 'var(--good)' },
  rate_limited: { label: 'RATE LIMITED', color: 'var(--warn)' },
  checking: { label: 'CHECKING…', color: 'var(--acc2)' },
  unknown: { label: 'UNVERIFIED', color: 'var(--dim)' },
  invalid: { label: 'INVALID', color: 'var(--bad)' },
  error: { label: 'ERROR', color: 'var(--bad)' },
}
const statusOf = (s: string) => STATUS[s] ?? STATUS.unknown

function UnifiedKeyPanel() {
  const queryClient = useQueryClient()
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)

  const { data } = useQuery<{ apiKey: string }>({ queryKey: ['unified-key'], queryFn: () => apiFetch('/api/settings/api-key') })
  const regenerate = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['unified-key'] }); setRevealed(false) },
  })

  const key = data?.apiKey ?? ''
  const shown = revealed ? key : (key ? key.slice(0, 14) + '••••••••••••••••••••••••••••' : '—')

  return (
    <div style={{ border: '1px solid var(--acc)', background: 'var(--panel)', padding: 20, marginBottom: 28, boxShadow: '0 0 30px var(--glow), inset 0 0 40px rgba(0,0,0,.3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: 1 }}>UNIFIED API KEY</div>
          <div style={{ color: 'var(--dim)', fontSize: 12, marginTop: 2 }}>One key to feed every agent. Provider keys stay encrypted (AES-256-GCM) behind it.</div>
        </div>
        <button onClick={() => regenerate.mutate()} disabled={regenerate.isPending} className="cy-txt-bad" style={{ all: 'unset', cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: 1, color: 'var(--bad)', border: '1px solid var(--bad)', padding: '7px 12px', transition: 'all .15s' }}>⟲ REGENERATE</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <code style={{ flex: 1, minWidth: 280, ...mono, fontSize: 13, color: 'var(--acc2)', background: 'var(--bg2)', border: '1px solid var(--line)', padding: '10px 12px', letterSpacing: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shown}</code>
        <button onClick={() => setRevealed(r => !r)} className="cy-hover-acc" style={{ all: 'unset', cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: 1, border: '1px solid var(--line)', padding: '0 14px', display: 'flex', alignItems: 'center' }}>{revealed ? 'HIDE' : 'SHOW'}</button>
        <button onClick={() => { if (key) { navigator.clipboard?.writeText(key).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1400) } }} className="cy-hover-acc" style={{ all: 'unset', cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: 1, border: '1px solid var(--line)', padding: '0 14px', display: 'flex', alignItems: 'center' }}>{copied ? 'COPIED ✓' : 'COPY'}</button>
      </div>
      <div style={{ display: 'flex', gap: 24, marginTop: 12, ...mono, fontSize: 11, color: 'var(--dim)', flexWrap: 'wrap' }}>
        <span>BASE_URL <span style={{ color: 'var(--ink)' }}>http://localhost:3001/v1</span></span>
        <span>ENDPOINT <span style={{ color: 'var(--ink)' }}>/v1/chat/completions</span></span>
      </div>
    </div>
  )
}

export default function KeysPage() {
  const queryClient = useQueryClient()
  const [addPlatform, setAddPlatform] = useState<string>('google')
  const [addDraft, setAddDraft] = useState('')
  const [addLabel, setAddLabel] = useState('')

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({ queryKey: ['keys'], queryFn: () => apiFetch('/api/keys') })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['keys'] })
    queryClient.invalidateQueries({ queryKey: ['health'] })
    queryClient.invalidateQueries({ queryKey: ['fallback'] })
  }
  const addKey = useMutation({ mutationFn: (b: { platform: string; key: string; label?: string }) => apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(b) }), onSuccess: invalidate })
  const deleteKey = useMutation({ mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }), onSuccess: invalidate })
  const checkKey = useMutation({ mutationFn: (id: number) => apiFetch(`/api/health/check/${id}`, { method: 'POST' }), onSuccess: invalidate })
  const checkAll = useMutation({ mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }), onSuccess: invalidate })

  const groups = PLATFORM_IDS
    .filter(id => keys.some(k => k.platform === id))
    .map(id => ({ id, name: platformName(id), keys: keys.filter(k => k.platform === id) }))

  const submitAdd = () => {
    if (!addDraft.trim()) return
    addKey.mutate({ platform: addPlatform, key: addDraft.trim(), label: addLabel.trim() || undefined })
    setAddDraft(''); setAddLabel('')
  }

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '36px 28px 80px', animation: 'flickin .35s ease' }}>
      <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// STEP 02 — ARM THE VAULT</div>
      <h1 style={{ margin: '0 0 24px', fontSize: 40, fontWeight: 700, letterSpacing: 1, textShadow: '0 0 24px var(--glow)' }}>KEY VAULT</h1>

      <UnifiedKeyPanel />

      <div style={{ border: '1px solid var(--line)', background: 'var(--panel2)', padding: 16, marginBottom: 28, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ ...mono, fontSize: 10, letterSpacing: 2, color: 'var(--dim)' }}>ADD KEY →</span>
        <select className="cy-input" value={addPlatform} onChange={e => setAddPlatform(e.target.value)} style={{ background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 12, padding: '8px 10px', minWidth: 180, ...mono }}>
          {PLATFORM_IDS.map(id => <option key={id} value={id}>{platformName(id)}</option>)}
        </select>
        <input className="cy-input" value={addDraft} onChange={e => setAddDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submitAdd() }} placeholder="paste key here" style={{ flex: 1, minWidth: 220, background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 12, padding: '8px 10px', ...mono }} />
        <input className="cy-input" value={addLabel} onChange={e => setAddLabel(e.target.value)} placeholder="label (optional)" style={{ width: 150, background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 12, padding: '8px 10px', ...mono }} />
        <button onClick={submitAdd} disabled={addKey.isPending} className="cy-btn" style={{ all: 'unset', cursor: 'pointer', fontSize: 12, fontWeight: 700, letterSpacing: 1, padding: '8px 16px', border: '1px solid var(--acc)', color: 'var(--acc)' }}>+ SLOT IN</button>
        <button onClick={() => checkAll.mutate()} disabled={checkAll.isPending} className="cy-txt-good" style={{ all: 'unset', cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: 1, border: '1px solid var(--line)', padding: '8px 12px', color: 'var(--dim)', transition: 'all .15s' }}>⟳ VERIFY ALL</button>
      </div>

      {isLoading ? (
        <p className="cy-mono" style={{ color: 'var(--dim)', fontSize: 12 }}>▸ reading vault…</p>
      ) : groups.length === 0 ? (
        <div style={{ border: '1px dashed var(--line)', padding: 40, textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>Vault empty — slot in a key above or jack in from Onboarding.</div>
      ) : groups.map(g => (
        <div key={g.id} style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '1px solid var(--line)', paddingBottom: 6, marginBottom: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14, letterSpacing: 1 }}>
              <span style={{ width: 8, height: 8, transform: 'rotate(45deg)', background: platformColor(g.id) }} />{g.name}
            </span>
            <span style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>{g.keys.length} {g.keys.length === 1 ? 'KEY' : 'KEYS'}</span>
          </div>
          {g.keys.map(k => {
            const s = statusOf(k.status)
            return (
              <div key={k.id} className="cy-hover-acc" style={{ display: 'flex', alignItems: 'center', gap: 14, border: '1px solid var(--line)', background: 'var(--panel)', padding: '10px 14px', marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.color, boxShadow: `0 0 8px ${s.color}`, animation: 'ledpulse 2.4s infinite' }} />
                <code style={{ ...mono, fontSize: 12, color: 'var(--ink)', letterSpacing: 1 }}>{k.maskedKey}</code>
                <span style={{ ...mono, fontSize: 10, color: s.color, letterSpacing: 1, border: `1px solid ${s.color}`, padding: '2px 6px' }}>{s.label}</span>
                {k.label && <span style={{ fontSize: 11, color: 'var(--dim)' }}>{k.label}</span>}
                <div style={{ flex: 1 }} />
                <span style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>{k.lastCheckedAt ? new Date(k.lastCheckedAt).toLocaleTimeString() : '—'}</span>
                <button onClick={() => checkKey.mutate(k.id)} className="cy-glow-acc2" style={{ all: 'unset', cursor: 'pointer', fontSize: 11, fontWeight: 600, letterSpacing: 1, color: 'var(--acc2)' }}>VERIFY</button>
                <button onClick={() => deleteKey.mutate(k.id)} className="cy-glow-bad" style={{ all: 'unset', cursor: 'pointer', fontSize: 11, fontWeight: 600, letterSpacing: 1, color: 'var(--bad)' }}>PURGE</button>
              </div>
            )
          })}
        </div>
      ))}

      <SearchProviders />
    </main>
  )
}
