import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

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
// disabled/unhealthy/penalized surface why.
function StatusPill({ inst }: { inst: Instance }) {
  if (!inst.enabled) {
    return <Badge variant="destructive">{inst.disabled_reason ? `off: ${inst.disabled_reason}` : 'disabled'}</Badge>
  }
  if (inst.health_status === 'inactive') return <Badge variant="destructive">unhealthy</Badge>
  if (inst.health_status === 'penalized') return <Badge variant="outline">degraded</Badge>
  return <Badge variant="secondary">healthy</Badge>
}

function ModelCard({ model }: { model: Canonical }) {
  const hardCaps = model.capabilities.filter(
    c => c.supported && !c.capability.startsWith('best_use_') && c.capability !== 'reachable',
  )
  const bestUse = model.capabilities.filter(c => c.supported && c.capability.startsWith('best_use_'))
  // Fastest healthy supplier — the headline "how fast is this model right now".
  const latencies = model.instances.map(i => i.recent_latency_ms).filter((n): n is number => n != null)
  const fastest = latencies.length ? Math.min(...latencies) : null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="text-base">{model.name}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
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
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Strengths/weaknesses paragraph — populated by the research cron
            (step 4); shown as a muted placeholder until then. */}
        <p className={`text-sm ${model.summary ? 'text-foreground' : 'text-muted-foreground italic'}`}>
          {model.summary ?? 'No summary yet — pending model research.'}
        </p>

        {/* Measured capability pills (source=measured, OR'd across suppliers). */}
        {hardCaps.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {hardCaps.map(c => (
              <Badge key={c.capability} variant="default">{CAP_LABELS[c.capability] ?? c.capability}</Badge>
            ))}
          </div>
        )}

        {/* Best-use tags (measured signals + curated tiers from the sweep). */}
        {bestUse.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {bestUse.map(c => (
              <Badge key={c.capability} variant="ghost">
                {c.capability.replace(/^best_use_/, '').replace(/_/g, ' ')}
              </Badge>
            ))}
          </div>
        )}

        {/* Quality scores per task type (lmarena, step 4). Empty until ingested. */}
        {model.taskScores.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {model.taskScores.map(s => (
              <Badge key={`${s.task_type}:${s.source}`} variant="secondary">
                {s.task_type.replace(/_/g, ' ')} {Math.round(s.score * 100)}
              </Badge>
            ))}
          </div>
        )}

        {/* Per-supplier table with live status + latency. */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground text-left border-b">
                <th className="font-medium py-1.5 pr-3">Supplier</th>
                <th className="font-medium py-1.5 pr-3">Model ID</th>
                <th className="font-medium py-1.5 pr-3">Status</th>
                <th className="font-medium py-1.5 pr-3">Latency</th>
                <th className="font-medium py-1.5 pr-3">Context</th>
                <th className="font-medium py-1.5">Tier</th>
              </tr>
            </thead>
            <tbody>
              {model.instances.map(inst => (
                <tr key={inst.id} className="border-b last:border-0">
                  <td className="py-1.5 pr-3 font-medium">{inst.platform}</td>
                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">{inst.model_id}</td>
                  <td className="py-1.5 pr-3"><StatusPill inst={inst} /></td>
                  <td className="py-1.5 pr-3 tabular-nums">{prettyLatency(inst.recent_latency_ms)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{prettyCtx(inst.context_window)}</td>
                  <td className="py-1.5">{inst.cost_tier}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
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
        <p className="text-sm text-muted-foreground">
          {models.length === 0
            ? 'No canonical models yet. Models appear here once matched across suppliers.'
            : 'No models match your search.'}
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map(m => <ModelCard key={m.id} model={m} />)}
        </div>
      )}
    </div>
  )
}
