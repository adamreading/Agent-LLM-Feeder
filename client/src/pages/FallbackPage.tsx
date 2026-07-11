import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { platformColor } from '@/lib/cyber'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const

interface ExplainRow {
  modelDbId: number; platform: string; modelId: string; displayName: string
  intelligenceRank: number; taskScore: number | null; penalty: number
  healthScore: number | null; latencyMs: number | null; effectiveScore: number
  keyCount: number; cooling: boolean; costTier: string
  status: 'eligible' | 'disabled' | 'no_key' | 'cooling'
}
interface OrderData { taskType: string; rows: ExplainRow[] }
interface TokenUsageData { totalBudget: number; totalUsed: number; models: { displayName: string; platform: string; budget: number }[] }

// Same weights the router uses (server/src/services/router.ts) so the breakdown
// the page SHOWS matches how a model is actually scored. Display only.
const HEALTH_WEIGHT = 10, TASK_WEIGHT = 12, LAT_DIV = 5000, LAT_CAP = 4

const TASKS = [
  { id: '', label: 'OVERALL' }, { id: 'coding', label: 'CODING' }, { id: 'math', label: 'MATH' },
  { id: 'reasoning', label: 'REASONING' }, { id: 'creative', label: 'CREATIVE' },
  { id: 'chat', label: 'CHAT' }, { id: 'long', label: 'LONG CTX' }, { id: 'instruction', label: 'INSTRUCTION' },
]

const STATUS_STYLE: Record<ExplainRow['status'], { label: string; color: string }> = {
  eligible: { label: 'ELIGIBLE', color: 'var(--good)' },
  cooling: { label: 'COOLING', color: 'var(--warn, #e0a030)' },
  no_key: { label: 'NO KEY', color: 'var(--dim)' },
  disabled: { label: 'DISABLED', color: 'var(--dim)' },
}

function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const { totalBudget, totalUsed, models } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? Math.round((remaining / totalBudget) * 100) : 0
  const withWidth = models.map(m => ({ ...m, widthPct: totalBudget > 0 ? (m.budget / totalBudget) * (remaining / totalBudget) * 100 : 0, rem: totalBudget > 0 ? (m.budget / totalBudget) * remaining : 0 }))
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0
  return (
    <section style={{ border: '1px solid var(--line)', background: 'var(--panel)', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>MONTHLY TOKEN BUDGET</h2>
        <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>
          <span style={{ color: 'var(--acc2)', fontWeight: 700 }}>{formatTokens(remaining)}</span> REMAINING · {remainingPct}% OF {formatTokens(totalBudget)}
        </span>
      </div>
      <div style={{ display: 'flex', height: 10, overflow: 'hidden', border: '1px solid var(--line)', padding: 1 }}>
        {withWidth.map((m, i) => (
          <div key={i} title={`${m.displayName} (${m.platform}) — ${formatTokens(m.rem)}`} style={{ width: `${m.widthPct}%`, background: platformColor(m.platform) }} />
        ))}
        {totalUsed > 0 && <div title={`used — ${formatTokens(totalUsed)}`} style={{ width: `${usedPct}%`, background: 'rgba(143,138,176,.3)' }} />}
      </div>

      {/* Per-model budget grid — the "all servable models by provider" view
          (restored 2026-07-11 per Adam). Colour = provider; number = that
          model's monthly free-tier budget. Only servable (enabled + keyed)
          models appear, so it mirrors what the router can actually reach. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: '3px 28px', marginTop: 16 }}>
        {models.map((m, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, ...mono, fontSize: 11.5, padding: '1px 0' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: platformColor(m.platform), flexShrink: 0 }} />
            <span style={{ flex: 1, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${m.displayName} · ${m.platform}`}>{m.displayName}</span>
            <span style={{ color: 'var(--dim)' }}>{formatTokens(m.budget)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// Score-composition breakdown for one model — mirrors candidateScore so the
// user sees exactly WHY a model sits where it does.
function Breakdown({ r }: { r: ExplainRow }) {
  const taskLift = r.taskScore != null ? -(Math.max(0, Math.min(1, r.taskScore)) * TASK_WEIGHT) : 0
  const healthPen = r.healthScore != null ? (1 - r.healthScore) * HEALTH_WEIGHT : 0
  const latPen = r.latencyMs != null ? Math.min(r.latencyMs / LAT_DIV, LAT_CAP) : 0
  const part = (label: string, val: number, sign: '+' | '−') => (
    <span style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>
      {label} <span style={{ color: sign === '−' ? 'var(--good)' : 'var(--ink)' }}>{sign}{Math.abs(val).toFixed(1)}</span>
    </span>
  )
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: '8px 14px 12px 46px', background: 'var(--bg2)', borderBottom: '1px solid var(--line)' }}>
      {part('intel-rank base', r.intelligenceRank, '+')}
      {r.taskScore != null && part(`task quality (${Math.round(r.taskScore * 100)})`, taskLift, '−')}
      {r.healthScore != null && part(`health (${Math.round(r.healthScore * 100)}%)`, healthPen, '+')}
      {r.latencyMs != null && part(`latency (${r.latencyMs}ms)`, latPen, '+')}
      {r.penalty > 0 && part('429 penalty', r.penalty, '+')}
      <span style={{ ...mono, fontSize: 10, color: 'var(--acc2)', fontWeight: 700 }}>= SCORE {r.effectiveScore.toFixed(1)}</span>
    </div>
  )
}

export default function FallbackPage() {
  const [task, setTask] = useState('')
  const [open, setOpen] = useState<number | null>(null)

  const { data, isLoading } = useQuery<OrderData>({
    queryKey: ['fallback-order', task],
    queryFn: () => apiFetch(`/api/fallback/order${task ? `?taskClass=${task}` : ''}`),
    refetchInterval: 15000, // reality view — refresh so health/penalty/cooldown stay live
  })
  const { data: tokenUsage } = useQuery<TokenUsageData>({ queryKey: ['fallback', 'token-usage'], queryFn: () => apiFetch('/api/fallback/token-usage') })

  const rows = data?.rows ?? []

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '36px 28px 80px', animation: 'flickin .35s ease' }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// LIVE ROUTING ORDER — DISPLAY ONLY</div>
        <h1 style={{ margin: 0, fontSize: 40, fontWeight: 700, letterSpacing: 1, textShadow: '0 0 24px var(--glow)' }}>FALLBACK</h1>
      </div>
      <p style={{ margin: '0 0 18px', color: 'var(--dim)', fontSize: 13, maxWidth: 680 }}>
        The real order the router would try models in <span style={{ color: 'var(--ink)' }}>right now</span>, scored by the same algorithm it uses live — intelligence prior, researched task quality, health, latency and 429 penalties. This page <span style={{ color: 'var(--acc)' }}>reflects</span> routing; it doesn't control it. Pick a task to see how the order shifts.
      </p>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 18 }}>
        {TASKS.map(t => {
          const active = task === t.id
          return (
            <button key={t.id} onClick={() => setTask(t.id)} className="cy-hover-acc" style={{
              all: 'unset', cursor: 'pointer', ...mono, fontSize: 10.5, fontWeight: 700, letterSpacing: 1,
              padding: '6px 12px', border: `1px solid ${active ? 'var(--acc)' : 'var(--line)'}`,
              color: active ? '#000' : 'var(--dim)', background: active ? 'var(--acc)' : 'transparent',
            }}>{t.label}</button>
          )
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {tokenUsage && tokenUsage.totalBudget > 0 && <TokenUsageBar data={tokenUsage} />}

        {isLoading ? (
          <p className="cy-mono" style={{ color: 'var(--dim)', fontSize: 12 }}>▸ computing live order…</p>
        ) : rows.length === 0 ? (
          <div style={{ border: '1px dashed var(--line)', padding: 40, textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>No models in the chain.</div>
        ) : (
          <div style={{ border: '1px solid var(--line)', overflow: 'hidden' }}>
            {rows.map((r, i) => {
              const st = STATUS_STYLE[r.status]
              const dimmed = r.status === 'disabled' || r.status === 'no_key'
              const isOpen = open === r.modelDbId
              return (
                <div key={r.modelDbId}>
                  <div
                    onClick={() => setOpen(isOpen ? null : r.modelDbId)}
                    className="cy-hover-acc"
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'var(--panel)', borderBottom: '1px solid var(--line)', opacity: dimmed ? 0.5 : 1, cursor: 'pointer' }}
                  >
                    <span style={{ ...mono, fontSize: 12, color: 'var(--dim)', width: 22 }}>{i + 1}</span>
                    <span style={{ width: 8, height: 8, transform: 'rotate(45deg)', background: platformColor(r.platform), flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{r.displayName}</span>
                        <span style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>{r.platform}</span>
                        {r.penalty > 0 && <span style={{ ...mono, fontSize: 10, color: 'var(--warn, #e0a030)' }}>-{r.penalty} PEN</span>}
                      </div>
                      <div style={{ display: 'flex', gap: 12, marginTop: 2, ...mono, fontSize: 10, color: 'var(--dim)', flexWrap: 'wrap' }}>
                        <span>INT #{r.intelligenceRank}</span>
                        {r.taskScore != null && <span style={{ color: 'var(--acc2)' }}>TASK {Math.round(r.taskScore * 100)}</span>}
                        {r.healthScore != null && <span>HP {Math.round(r.healthScore * 100)}%</span>}
                        {r.latencyMs != null && <span>{r.latencyMs}ms</span>}
                        {r.keyCount > 0 && <span>{r.keyCount} key{r.keyCount === 1 ? '' : 's'}</span>}
                      </div>
                    </div>
                    <span style={{ ...mono, fontSize: 11, color: 'var(--acc2)', fontWeight: 700 }}>{r.effectiveScore.toFixed(1)}</span>
                    <span style={{ ...mono, fontSize: 9, letterSpacing: 1, color: st.color, border: `1px solid ${st.color}`, padding: '3px 6px', minWidth: 56, textAlign: 'center' }}>{st.label}</span>
                  </div>
                  {isOpen && <Breakdown r={r} />}
                </div>
              )
            })}
          </div>
        )}
        <p style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>SCORE = intelligence-rank − task-quality + (1−health)×10 + latency + 429-penalty · lower = tried earlier · click a row for the breakdown</p>
      </div>
    </main>
  )
}
