import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { apiFetch } from '@/lib/api'
import { platformColor } from '@/lib/cyber'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const

interface FallbackEntry {
  modelDbId: number; priority: number; effectivePriority: number; penalty: number; rateLimitHits: number
  enabled: boolean; platform: string; modelId: string; displayName: string; intelligenceRank: number
  speedRank: number; sizeLabel: string; rpmLimit: number | null; rpdLimit: number | null
  monthlyTokenBudget: string; keyCount: number
}
interface TokenUsageData { totalBudget: number; totalUsed: number; models: { displayName: string; platform: string; budget: number }[] }

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
      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: '6px 20px', ...mono, fontSize: 11 }}>
        {withWidth.map((m, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ width: 8, height: 8, transform: 'rotate(45deg)', background: platformColor(m.platform), flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.displayName}</span>
            <span style={{ flex: 1 }} />
            <span style={{ color: 'var(--dim)' }}>{formatTokens(m.rem)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function SortableRow({ entry, index, onToggle }: { entry: FallbackEntry; index: number; onToggle: (id: number, e: boolean) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.modelDbId })
  const style = { transform: CSS.Transform.toString(transform), transition }
  return (
    <div ref={setNodeRef} style={{ ...style, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'var(--panel)', borderBottom: '1px solid var(--line)', opacity: (isDragging || !entry.enabled) ? 0.5 : 1 }}>
      <button {...attributes} {...listeners} className="cy-txt-acc" style={{ all: 'unset', cursor: 'grab', color: 'var(--dim)' }} aria-label="drag to reorder">⠿</button>
      <span style={{ ...mono, fontSize: 12, color: 'var(--dim)', width: 20 }}>{index + 1}</span>
      <span style={{ width: 8, height: 8, transform: 'rotate(45deg)', background: platformColor(entry.platform), flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{entry.displayName}</span>
          <span style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>{entry.platform}</span>
          {entry.penalty > 0 && <span style={{ ...mono, fontSize: 10, color: 'var(--warn)' }}>-{entry.penalty} PENALTY</span>}
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 2, ...mono, fontSize: 10, color: 'var(--dim)' }}>
          <span>INT #{entry.intelligenceRank}</span><span>SPD #{entry.speedRank}</span>
          {entry.rpmLimit && <span>{entry.rpmLimit} rpm</span>}
          {entry.rpdLimit && <span>{entry.rpdLimit} rpd</span>}
          <span>{entry.monthlyTokenBudget} tok/mo</span>
        </div>
      </div>
      <button onClick={() => onToggle(entry.modelDbId, !entry.enabled)} style={{
        all: 'unset', cursor: 'pointer', ...mono, fontSize: 10, letterSpacing: 1, padding: '3px 8px',
        border: `1px solid ${entry.enabled ? 'var(--good)' : 'var(--line)'}`, color: entry.enabled ? 'var(--good)' : 'var(--dim)',
      }}>{entry.enabled ? '◈ ON' : 'OFF'}</button>
    </div>
  )
}

export default function FallbackPage() {
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({ queryKey: ['fallback'], queryFn: () => apiFetch('/api/fallback') })
  const { data: tokenUsage } = useQuery<TokenUsageData>({ queryKey: ['fallback', 'token-usage'], queryFn: () => apiFetch('/api/fallback/token-usage') })

  const saveMutation = useMutation({ mutationFn: (d: { modelDbId: number; priority: number; enabled: boolean }[]) => apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(d) }), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['fallback'] }); setLocalEntries(null) } })
  const sortMutation = useMutation({ mutationFn: (preset: string) => apiFetch(`/api/fallback/sort/${preset}`, { method: 'POST' }), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['fallback'] }); setLocalEntries(null) } })

  const allEntries = localEntries ?? entries
  const displayEntries = allEntries.filter(e => e.keyCount > 0)
  const unconfigured = [...new Set(allEntries.filter(e => e.keyCount === 0).map(e => e.platform))]
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = displayEntries.findIndex(e => e.modelDbId === active.id)
    const newIndex = displayEntries.findIndex(e => e.modelDbId === over.id)
    const reordered = arrayMove(displayEntries, oldIndex, newIndex)
    const unc = allEntries.filter(e => e.keyCount === 0)
    setLocalEntries([...reordered.map((e, i) => ({ ...e, priority: i + 1 })), ...unc.map((e, i) => ({ ...e, priority: reordered.length + i + 1 }))])
  }
  function handleToggle(id: number, enabled: boolean) { setLocalEntries(allEntries.map(e => e.modelDbId === id ? { ...e, enabled } : e)) }
  function handleSave() { if (localEntries) saveMutation.mutate(allEntries.map(e => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: e.enabled }))) }
  const hasChanges = localEntries !== null

  const sortBtn = (preset: string, label: string) => (
    <button onClick={() => sortMutation.mutate(preset)} disabled={sortMutation.isPending} className="cy-hover-acc" style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 11, fontWeight: 700, letterSpacing: 1, border: '1px solid var(--line)', color: 'var(--dim)', padding: '8px 12px' }}>{label}</button>
  )

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '36px 28px 80px', animation: 'flickin .35s ease' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// FAILOVER CHAIN</div>
          <h1 style={{ margin: 0, fontSize: 40, fontWeight: 700, letterSpacing: 1, textShadow: '0 0 24px var(--glow)' }}>FALLBACK</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{sortBtn('intelligence', 'SORT INTEL')}{sortBtn('speed', 'SORT SPEED')}{sortBtn('budget', 'SORT BUDGET')}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {tokenUsage && tokenUsage.totalBudget > 0 && <TokenUsageBar data={tokenUsage} />}

        {isLoading ? (
          <p className="cy-mono" style={{ color: 'var(--dim)', fontSize: 12 }}>▸ loading chain…</p>
        ) : displayEntries.length === 0 ? (
          <div style={{ border: '1px dashed var(--line)', padding: 40, textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>No keyed models — add keys to populate the chain.</div>
        ) : (
          <>
            <div style={{ border: '1px solid var(--line)', overflow: 'hidden' }}>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={displayEntries.map(e => e.modelDbId)} strategy={verticalListSortingStrategy}>
                  {displayEntries.map((entry, i) => <SortableRow key={entry.modelDbId} entry={entry} index={i} onToggle={handleToggle} />)}
                </SortableContext>
              </DndContext>
            </div>
            {hasChanges && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={() => setLocalEntries(null)} className="cy-hover-acc" style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 11, fontWeight: 700, letterSpacing: 1, border: '1px solid var(--line)', color: 'var(--dim)', padding: '8px 14px' }}>DISCARD</button>
                <button onClick={handleSave} disabled={saveMutation.isPending} className="cy-btn" style={{ all: 'unset', cursor: 'pointer', ...mono, fontSize: 11, fontWeight: 700, letterSpacing: 1, border: '1px solid var(--acc)', color: 'var(--acc)', padding: '8px 14px' }}>{saveMutation.isPending ? 'SAVING…' : 'SAVE ORDER'}</button>
              </div>
            )}
            {unconfigured.length > 0 && <p style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>HIDDEN (no keys): {unconfigured.join(', ')}</p>}
          </>
        )}
      </div>
    </main>
  )
}
