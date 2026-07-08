import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, Legend,
} from 'recharts'
import { apiFetch } from '@/lib/api'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const
type TimeRange = '24h' | '7d' | '30d'

function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ border: '1px solid var(--line)', background: 'var(--panel)', padding: '10px 16px' }}>
      <p style={{ margin: 0, ...mono, fontSize: 10, color: 'var(--dim)', letterSpacing: 1, textTransform: 'uppercase' }}>{label}</p>
      <p style={{ margin: '4px 0 0', fontSize: 20, fontWeight: 700, color: 'var(--acc2)' }} className="tabular-nums">{value}</p>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--line)', background: 'var(--panel)' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: 1 }}>{title}</h3>
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  )
}

const axisStyle = { fontSize: 11, fill: 'var(--dim)', fontFamily: "'JetBrains Mono',monospace" } as const
const grid = 'var(--line)'
const empty = <p style={{ textAlign: 'center', padding: '32px 0', ...mono, fontSize: 12, color: 'var(--dim)' }}>▸ no data yet</p>
const tooltipStyle = { backgroundColor: 'var(--panel)', border: '1px solid var(--acc)', fontSize: 12, color: 'var(--ink)' }

export default function AnalyticsPage() {
  const [range, setRange] = useState<TimeRange>('7d')
  const q = <T,>(k: string, path: string) => useQuery<T>({ queryKey: ['analytics', k, range], queryFn: () => apiFetch<T>(path) })

  const { data: summary } = q<any>('summary', `/api/analytics/summary?range=${range}`)
  const { data: byPlatform = [] } = q<any[]>('by-platform', `/api/analytics/by-platform?range=${range}`)
  const { data: timeline = [] } = q<any[]>('timeline', `/api/analytics/timeline?range=${range}`)
  const { data: byModel = [] } = q<any[]>('by-model', `/api/analytics/by-model?range=${range}`)
  const { data: errors = [] } = q<any[]>('errors', `/api/analytics/errors?range=${range}`)
  const { data: errorDist } = q<{ byCategory: any[]; byPlatform: any[]; detailed: any[] }>('error-distribution', `/api/analytics/error-distribution?range=${range}`)

  const th: React.CSSProperties = { ...mono, fontSize: 9.5, color: 'var(--dim)', letterSpacing: 1, textAlign: 'left', padding: '0 10px 6px', borderBottom: '1px solid var(--line)' }
  const td: React.CSSProperties = { fontSize: 12, padding: '8px 10px', borderBottom: '1px solid var(--line)' }
  const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontFamily: "'JetBrains Mono',monospace" }

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '36px 28px 80px', animation: 'flickin .35s ease' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// TELEMETRY GRID</div>
          <h1 style={{ margin: 0, fontSize: 40, fontWeight: 700, letterSpacing: 1, textShadow: '0 0 24px var(--glow)' }}>ANALYTICS</h1>
        </div>
        <div style={{ display: 'flex', gap: 2, border: '1px solid var(--line)', padding: 2 }}>
          {(['24h', '7d', '30d'] as TimeRange[]).map(r => (
            <button key={r} onClick={() => setRange(r)} style={{
              all: 'unset', cursor: 'pointer', ...mono, fontSize: 11, fontWeight: 700, letterSpacing: 1, padding: '6px 12px',
              background: range === r ? 'var(--acc)' : 'transparent', color: range === r ? '#000' : 'var(--dim)',
            }}>{r.toUpperCase()}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 12 }}>
          <Stat label="Requests" value={summary?.totalRequests ?? 0} />
          <Stat label="Success Rate" value={`${summary?.successRate ?? 0}%`} />
          <Stat label="Input Tokens" value={formatTokens(summary?.totalInputTokens)} />
          <Stat label="Output Tokens" value={formatTokens(summary?.totalOutputTokens)} />
          <Stat label="Avg Latency" value={`${summary?.avgLatencyMs ?? 0} ms`} />
          <Stat label="Est Savings" value={`$${summary?.estimatedCostSavings ?? '0.00'}`} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 14 }}>
          <Panel title="REQUESTS BY PROVIDER">
            {byPlatform.length === 0 ? empty : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={grid} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: grid }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--line)' }} />
                  <Bar dataKey="requests" fill="var(--acc)" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title="LATENCY BY PROVIDER">
            {byPlatform.length === 0 ? empty : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={grid} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: grid }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--line)' }} />
                  <Bar dataKey="avgLatencyMs" name="latency (ms)" fill="var(--acc2)" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>
        </div>

        <Panel title="REQUESTS OVER TIME">
          {timeline.length === 0 ? empty : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke={grid} />
                <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: grid }} />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12, fontFamily: "'JetBrains Mono',monospace" }} iconType="line" />
                <Line type="monotone" dataKey="successCount" name="success" stroke="var(--good)" strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="failureCount" name="failures" stroke="var(--bad)" strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="PER-MODEL BREAKDOWN">
          {byModel.length === 0 ? empty : (
            <div style={{ maxHeight: 360, overflowY: 'auto', margin: '0 -16px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={{ ...th, paddingLeft: 16 }}>MODEL</th><th style={th}>PROVIDER</th>
                  <th style={{ ...th, textAlign: 'right' }}>REQ</th><th style={{ ...th, textAlign: 'right' }}>SUCCESS</th>
                  <th style={{ ...th, textAlign: 'right' }}>LATENCY</th><th style={{ ...th, textAlign: 'right' }}>IN</th>
                  <th style={{ ...th, textAlign: 'right', paddingRight: 16 }}>OUT</th>
                </tr></thead>
                <tbody>
                  {byModel.map((m: any, i: number) => (
                    <tr key={i}>
                      <td style={{ ...td, paddingLeft: 16, fontWeight: 600 }}>{m.displayName}</td>
                      <td style={{ ...td, ...mono, fontSize: 11, color: 'var(--dim)' }}>{m.platform}</td>
                      <td style={tdR}>{m.requests}</td>
                      <td style={tdR}>{m.successRate}%</td>
                      <td style={tdR}>{m.avgLatencyMs} ms</td>
                      <td style={tdR}>{formatTokens(m.totalInputTokens)}</td>
                      <td style={{ ...tdR, paddingRight: 16 }}>{formatTokens(m.totalOutputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 14 }}>
          <Panel title="ERRORS BY PROVIDER">
            {!errorDist?.byPlatform?.length ? <p style={{ textAlign: 'center', padding: '32px 0', ...mono, fontSize: 12, color: 'var(--good)' }}>◈ no errors</p> : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={grid} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: grid }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--line)' }} />
                  <Bar dataKey="count" fill="var(--bad)" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title="RECENT ERRORS">
            {errors.length === 0 ? <p style={{ textAlign: 'center', padding: '32px 0', ...mono, fontSize: 12, color: 'var(--good)' }}>◈ no errors</p> : (
              <div style={{ maxHeight: 240, overflowY: 'auto', margin: '0 -16px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={{ ...th, paddingLeft: 16 }}>PROVIDER</th><th style={th}>MESSAGE</th>
                    <th style={{ ...th, textAlign: 'right', paddingRight: 16 }}>TIME</th>
                  </tr></thead>
                  <tbody>
                    {errors.slice(0, 20).map((e: any) => (
                      <tr key={e.id}>
                        <td style={{ ...td, ...mono, fontSize: 11 }}>{e.platform}</td>
                        <td style={{ ...td, fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.error}</td>
                        <td style={{ ...tdR, fontSize: 11, color: 'var(--dim)', paddingRight: 16 }}>{new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </main>
  )
}
