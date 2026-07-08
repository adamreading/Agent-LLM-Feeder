import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { apiFetch } from '@/lib/api'
import {
  type CanonModel, CAP_LABELS, TASK_LABELS, makerFromName, prettyCtx, prettyLatency,
  latencyColor, bestIntel, bestSpeed, maxCtx, fastestLatency,
} from '@/lib/cyber'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const

// Capabilities shown in the matrix, in a stable order. A measured-true row →
// GOOD; measured-false → NONE; no row at all → UNPROBED.
const MATRIX_CAPS = ['tools', 'json_mode', 'long_context', 'vision', 'video', 'audio', 'ob_readwrite', 'reasoning_control']

function Panel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ border: '1px solid var(--line)', background: 'var(--panel)', padding: 18, ...style }}>{children}</div>
}

function SectionTitle({ children, color }: { children: React.ReactNode; color?: string }) {
  return <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: 2, marginBottom: 12, color }}>{children}</div>
}

export default function ModelDetailPage() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const { data: models = [], isLoading } = useQuery<CanonModel[]>({
    queryKey: ['canon'],
    queryFn: () => apiFetch('/api/canon'),
  })

  const back = (
    <button onClick={() => navigate('/wiki')} className="cy-txt-acc" style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 11, letterSpacing: 1, color: 'var(--dim)', marginBottom: 18, display: 'block' }}>◂ BACK TO INDEX</button>
  )

  if (isLoading) {
    return <main style={{ maxWidth: 1180, margin: '0 auto', padding: '28px 28px 80px' }}>{back}<p className="cy-mono" style={{ color: 'var(--dim)', fontSize: 12 }}>▸ loading model file…</p></main>
  }

  const m = models.find(x => x.slug === slug)
  if (!m) {
    return <main style={{ maxWidth: 1180, margin: '0 auto', padding: '28px 28px 80px' }}>{back}<p className="cy-mono" style={{ color: 'var(--bad)', fontSize: 13 }}>MODEL FILE NOT FOUND // {slug}</p></main>
  }

  const stats = [
    { k: 'INTEL RANK', v: bestIntel(m) != null ? `#${bestIntel(m)}` : '—' },
    { k: 'SPEED RANK', v: bestSpeed(m) != null ? `#${bestSpeed(m)}` : '—' },
    { k: 'CONTEXT', v: prettyCtx(maxCtx(m)) },
    { k: 'BEST LATENCY', v: prettyLatency(fastestLatency(m)) },
  ]

  const capByName = new Map(m.capabilities.map(c => [c.capability, c.supported]))
  const tasks = m.taskScores.filter(s => s.task_type !== 'overall')

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '28px 28px 80px', animation: 'flickin .35s ease' }}>
      {back}

      {/* Hero */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap', border: '1px solid var(--acc)', background: 'var(--panel)', padding: 22, boxShadow: '0 0 30px var(--glow)' }}>
        <div style={{ maxWidth: 640 }}>
          <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 4 }}>MODEL FILE // {m.slug}</div>
          <h1 style={{ margin: 0, fontSize: 34, fontWeight: 700, letterSpacing: 1, textShadow: '0 0 20px var(--glow)' }}>{m.name.toUpperCase()}</h1>
          <p style={{ margin: '10px 0 0', color: m.summary ? 'var(--ink)' : 'var(--dim)', fontSize: 14, lineHeight: 1.55, fontStyle: m.summary ? 'normal' : 'italic' }}>
            {m.summary ?? `${makerFromName(m.name)} model · served free by ${m.instances.length} provider${m.instances.length === 1 ? '' : 's'}. Strengths summary pending model research.`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {stats.map(s => (
            <div key={s.k} style={{ border: '1px solid var(--line)', background: 'var(--bg2)', padding: '10px 16px', textAlign: 'center', minWidth: 86 }}>
              <div style={{ ...mono, fontSize: 9, color: 'var(--dim)', letterSpacing: 1 }}>{s.k}</div>
              <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--acc2)', marginTop: 2 }}>{s.v}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14, alignItems: 'start' }}>
        {/* Left: capability matrix + task scores */}
        <Panel>
          <SectionTitle>CAPABILITY MATRIX</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {MATRIX_CAPS.map(cap => {
              const has = capByName.has(cap)
              const ok = capByName.get(cap) === true
              const verdict = !has ? '◇ UNPROBED' : ok ? '◈ GOOD' : '— NONE'
              const color = !has ? 'var(--dim)' : ok ? 'var(--good)' : 'var(--bad)'
              return (
                <div key={cap} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid var(--line)', background: 'var(--bg2)', padding: '8px 12px' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: 1 }}>{CAP_LABELS[cap] ?? cap.toUpperCase()}</span>
                  <span style={{ ...mono, fontSize: 10, fontWeight: 700, letterSpacing: 1, color, textShadow: `0 0 8px ${color}` }}>{verdict}</span>
                </div>
              )
            })}
          </div>

          <div style={{ marginTop: 16, fontWeight: 700, fontSize: 14, letterSpacing: 2, marginBottom: 10 }}>
            TASK SCORES <span style={{ ...mono, fontSize: 9, color: 'var(--dim)', fontWeight: 400 }}>SRC: LMARENA</span>
          </div>
          {tasks.length === 0 ? (
            <div style={{ border: '1px dashed var(--line)', padding: 14, ...mono, fontSize: 10.5, color: 'var(--dim)', lineHeight: 1.6 }}>
              ▸ PROBE PENDING — per-task arena scores populate once the weekly lmarena ingest runs.
            </div>
          ) : tasks.map(t => {
            const pct = Math.round(t.score * 100)
            const barColor = pct >= 88 ? 'var(--good)' : pct >= 75 ? 'var(--acc)' : 'var(--warn)'
            return (
              <div key={t.task_type} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
                <span style={{ width: 130, ...mono, fontSize: 10, color: 'var(--dim)', letterSpacing: '.5px' }}>{TASK_LABELS[t.task_type] ?? t.task_type.toUpperCase()}</span>
                <div style={{ flex: 1, height: 8, background: 'var(--bg2)', border: '1px solid var(--line)' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: barColor, boxShadow: `0 0 6px ${barColor}` }} />
                </div>
                <span style={{ width: 34, textAlign: 'right', ...mono, fontSize: 10, color: 'var(--ink)' }}>{pct}</span>
              </div>
            )
          })}
        </Panel>

        {/* Right: served-by + gotchas + good/bad */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Panel>
            <SectionTitle>SERVED BY <span style={{ color: 'var(--dim)', ...mono, fontSize: 9, fontWeight: 400 }}>FREE-TIER PROBES</span></SectionTitle>
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr .8fr .6fr .6fr .9fr', ...mono, fontSize: 9.5, color: 'var(--dim)', letterSpacing: 1, padding: '0 0 6px', borderBottom: '1px solid var(--line)' }}>
              <span>PROVIDER</span><span>LATENCY</span><span>RPM</span><span>RPD</span><span>TOK/MO</span>
            </div>
            {m.instances.map(sv => (
              <div key={sv.id} style={{ display: 'grid', gridTemplateColumns: '1.4fr .8fr .6fr .6fr .9fr', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--line)', opacity: sv.enabled ? 1 : 0.5 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: sv.enabled ? 'var(--good)' : 'var(--dim)', boxShadow: `0 0 6px ${sv.enabled ? 'var(--good)' : 'transparent'}` }} />
                  {sv.platform}
                </span>
                <span style={{ ...mono, fontSize: 11, color: latencyColor(sv.recent_latency_ms) }}>{prettyLatency(sv.recent_latency_ms)}</span>
                <span style={{ ...mono, fontSize: 11, color: 'var(--ink)' }}>{sv.rpm_limit ?? '—'}</span>
                <span style={{ ...mono, fontSize: 11, color: 'var(--ink)' }}>{sv.rpd_limit ?? '—'}</span>
                <span style={{ ...mono, fontSize: 11, color: 'var(--acc2)' }}>{sv.monthly_token_budget || '—'}</span>
              </div>
            ))}
            <div style={{ marginTop: 10, ...mono, fontSize: 10, color: 'var(--dim)' }}>All rows are $0.00 — that's the point.</div>
          </Panel>

          <Panel>
            <SectionTitle color="var(--warn)">⚠ STREET GOTCHAS</SectionTitle>
            <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', lineHeight: 1.6 }}>
              ▸ No curated gotchas logged yet — provider quirks surface here as probes and live traffic reveal them.
            </div>
          </Panel>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div style={{ border: '1px solid rgba(61,255,160,.4)', background: 'var(--panel)', padding: 16 }}>
              <div style={{ ...mono, fontSize: 10, fontWeight: 700, letterSpacing: 2, color: 'var(--good)', marginBottom: 8 }}>RUNS HOT ON</div>
              {(() => {
                const good = m.capabilities.filter(c => c.supported && c.capability.startsWith('best_use_')).slice(0, 4)
                return good.length
                  ? good.map(c => <div key={c.capability} style={{ fontSize: 12, color: 'var(--ink)', padding: '3px 0' }}>+ {c.capability.replace(/^best_use_/, '').replace(/_/g, ' ')}</div>)
                  : <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>pending</div>
              })()}
            </div>
            <div style={{ border: '1px solid rgba(255,77,107,.4)', background: 'var(--panel)', padding: 16 }}>
              <div style={{ ...mono, fontSize: 10, fontWeight: 700, letterSpacing: 2, color: 'var(--bad)', marginBottom: 8 }}>DON'T FEED IT</div>
              {(() => {
                const bad = m.capabilities.filter(c => !c.supported && !c.capability.startsWith('best_use_') && c.capability !== 'reachable').slice(0, 4)
                return bad.length
                  ? bad.map(c => <div key={c.capability} style={{ fontSize: 12, color: 'var(--ink)', padding: '3px 0' }}>− {(CAP_LABELS[c.capability] ?? c.capability).toLowerCase()}</div>)
                  : <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>pending</div>
              })()}
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
