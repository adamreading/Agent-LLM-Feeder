import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

// Mirrors the GET /api/canon response (server/src/routes/canon.ts). The wiki
// reads canonical models ONLY — supplier rows that haven't completed matching
// are deliberately invisible here (Adam's directive: a model enters the wiki
// only once it's canonicalized).
interface Instance {
  id: number
  platform: string
  model_id: string
  display_name: string
  enabled: boolean
  disabled_reason: string | null
  context_window: number | null
  size_label: string
  cost_tier: string
  recent_latency_ms: number | null
  health_score: number | null
  health_status: string | null
}
interface Capability { capability: string; supported: boolean }
interface TaskScore { task_type: string; score: number; rank: number | null; source: string }
interface Canonical {
  id: number
  name: string
  slug: string
  summary: string | null
  vision: boolean
  video: boolean
  audio: boolean
  instances: Instance[]
  capabilities: Capability[]
  taskScores: TaskScore[]
}

// Friendly labels for the measured hard-capability pills.
const CAP_LABELS: Record<string, string> = {
  tools: 'Tools',
  json_mode: 'JSON mode',
  long_context: 'Long context',
  ob_readwrite: 'OB read/write',
  vision: 'Vision',
  reasoning_control: 'Reasoning control',
  reachable: 'Reachable',
}

// Shared with FallbackPage / AnalyticsPage — one colour per supplier so a
// platform reads consistently across the whole UI.
const platformColors: Record<string, string> = {
  google: '#4285f4', groq: '#f55036', cerebras: '#8b5cf6', sambanova: '#14b8a6',
  nvidia: '#76b900', mistral: '#f59e0b', openrouter: '#ec4899', github: '#6e7b8b',
  cohere: '#d946ef', cloudflare: '#f38020', zhipu: '#06b6d4', ollama: '#000000',
  kilo: '#7c3aed', pollinations: '#a855f7', llm7: '#0ea5e9',
}

function prettyCtx(n: number | null): string {
  if (!n) return '—'
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function prettyLatency(ms: number | null): string {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

// One supplier row's live status → a pill. enabled+healthy is the common case;
// disabled/unhealthy/degraded surface why.
function StatusPill({ inst }: { inst: Instance }) {
  if (!inst.enabled) {
    return <Badge variant="destructive">{inst.disabled_reason ? `off · ${inst.disabled_reason}` : 'off'}</Badge>
  }
  if (inst.health_status === 'inactive') return <Badge variant="destructive">unhealthy</Badge>
  if (inst.health_status === 'penalized') return <Badge variant="outline">degraded</Badge>
  return <Badge variant="secondary">healthy</Badge>
}

function ModelPanel({ model }: { model: Canonical }) {
  const hardCaps = model.capabilities.filter(
    c => c.supported && !c.capability.startsWith('best_use_') && c.capability !== 'reachable',
  )
  const bestUse = model.capabilities.filter(c => c.supported && c.capability.startsWith('best_use_'))
  const latencies = model.instances.map(i => i.recent_latency_ms).filter((n): n is number => n != null)
  const fastest = latencies.length ? Math.min(...latencies) : null

  return (
    <section className="rounded-lg border bg-card p-5 space-y-4">
      {/* Header: name + supplier count/fastest, multimodal badges right */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight truncate">{model.name}</h2>
          <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
            {model.instances.length} supplier{model.instances.length === 1 ? '' : 's'}
            {fastest != null && <> · fastest {prettyLatency(fastest)}</>}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1 shrink-0">
          {model.vision && <Badge variant="outline">Vision</Badge>}
          {model.video && <Badge variant="outline">Video</Badge>}
          {model.audio && <Badge variant="outline">Audio</Badge>}
        </div>
      </div>

      {/* Strengths/weaknesses paragraph — populated by the research cron;
          muted placeholder until then. */}
      <p className={`text-sm ${model.summary ? 'text-foreground' : 'text-muted-foreground italic'}`}>
        {model.summary ?? 'No summary yet — pending model research.'}
      </p>

      {/* Measured capabilities (source=measured, OR'd across suppliers). */}
      {hardCaps.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {hardCaps.map(c => (
            <Badge key={c.capability} variant="default">{CAP_LABELS[c.capability] ?? c.capability}</Badge>
          ))}
        </div>
      )}

      {/* Best-use tags + per-task quality scores (scores empty until step 4). */}
      {(bestUse.length > 0 || model.taskScores.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {model.taskScores.map(s => (
            <Badge key={`${s.task_type}:${s.source}`} variant="secondary">
              {s.task_type.replace(/_/g, ' ')} {Math.round(s.score * 100)}
            </Badge>
          ))}
          {bestUse.map(c => (
            <Badge key={c.capability} variant="ghost">
              {c.capability.replace(/^best_use_/, '').replace(/_/g, ' ')}
            </Badge>
          ))}
        </div>
      )}

      {/* Per-supplier table with live status + latency. */}
      <div className="-mx-5 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Supplier</TableHead>
              <TableHead>Model ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead className="text-right">Context</TableHead>
              <TableHead className="text-right pr-5">Tier</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {model.instances.map(inst => (
              <TableRow key={inst.id} className={inst.enabled ? '' : 'opacity-60'}>
                <TableCell className="pl-5 font-medium">
                  <span className="flex items-center gap-2">
                    <span className="size-2 rounded-sm flex-shrink-0" style={{ backgroundColor: platformColors[inst.platform] ?? '#94a3b8' }} />
                    {inst.platform}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{inst.model_id}</TableCell>
                <TableCell><StatusPill inst={inst} /></TableCell>
                <TableCell className="text-right tabular-nums">{prettyLatency(inst.recent_latency_ms)}</TableCell>
                <TableCell className="text-right tabular-nums">{prettyCtx(inst.context_window)}</TableCell>
                <TableCell className="text-right pr-5 text-muted-foreground">{inst.cost_tier}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

export default function ModelWikiPage() {
  const { t } = useI18n()
  const [q, setQ] = useState('')

  const { data: models = [], isLoading } = useQuery<Canonical[]>({
    queryKey: ['canon'],
    queryFn: () => apiFetch('/api/canon'),
  })

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return models
    return models.filter(m =>
      m.name.toLowerCase().includes(needle) ||
      m.slug.toLowerCase().includes(needle) ||
      m.instances.some(i => i.platform.toLowerCase().includes(needle) || i.model_id.toLowerCase().includes(needle)) ||
      m.capabilities.some(c => c.supported && c.capability.toLowerCase().includes(needle)),
    )
  }, [models, q])

  return (
    <div>
      <PageHeader
        title="Models"
        description="Every model in the catalog, grouped across the suppliers that offer it — with measured capabilities and live health."
        actions={
          <Input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search models, suppliers, capabilities…"
            className="w-72"
          />
        }
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {models.length === 0
              ? 'No canonical models yet. Models appear here once matched across suppliers.'
              : 'No models match your search.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {filtered.map(m => <ModelPanel key={m.id} model={m} />)}
        </div>
      )}
    </div>
  )
}
