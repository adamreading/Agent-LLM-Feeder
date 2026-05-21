import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Bot, FileText, RefreshCw, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/page-header'

interface AgentStatus {
  status: string
  workspaceRoot: string
  capabilities: string[]
}

interface AgentFiles {
  files: string[]
  total: number
}

interface AgentReply {
  content: string
  routedVia?: {
    platform: string
    model: string
    displayName: string
  }
}

export default function AgentPage() {
  const { t, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [reply, setReply] = useState<AgentReply | null>(null)

  const { data: status } = useQuery<AgentStatus>({
    queryKey: ['agent', 'status'],
    queryFn: () => apiFetch('/api/agent/status'),
  })

  const { data: filesData, refetch } = useQuery<AgentFiles>({
    queryKey: ['agent', 'files', query],
    queryFn: () => apiFetch(`/api/agent/files?q=${encodeURIComponent(query)}`),
  })

  const ask = useMutation({
    mutationFn: (body: { message: string; paths: string[]; language: string }) =>
      apiFetch<AgentReply>('/api/agent/chat', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: setReply,
  })

  const files = filesData?.files ?? []
  const selectedSet = useMemo(() => new Set(selected), [selected])

  function toggleFile(file: string) {
    setSelected(prev => prev.includes(file)
      ? prev.filter(item => item !== file)
      : [...prev, file].slice(0, 8))
  }

  function runAgent() {
    const trimmed = message.trim()
    if (!trimmed || ask.isPending) return
    ask.mutate({ message: trimmed, paths: selected, language: locale })
  }

  return (
    <div>
      <PageHeader
        title={t('agentTitle')}
        description={t('agentDescription')}
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw />
            {t('agentRefresh')}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <aside className="space-y-4">
          <section className="rounded-lg border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">{t('agentWorkspace')}</h2>
              <Badge variant="outline">{t('agentReady')}</Badge>
            </div>
            <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
              {status?.workspaceRoot ?? '...'}
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              {t('agentVisualStudioHint')}
            </p>
          </section>

          <section className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">{t('agentFiles')}</h2>
              <span className="text-xs text-muted-foreground tabular-nums">{files.length}</span>
            </div>
            <Input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('agentSearchPlaceholder')}
              className="mb-3"
            />
            <div className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
              {files.map(file => {
                const active = selectedSet.has(file)
                return (
                  <button
                    key={file}
                    type="button"
                    onClick={() => toggleFile(file)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                      active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                  >
                    <FileText className="size-3.5 shrink-0" />
                    <span className="truncate">{file}</span>
                    <span className="ml-auto text-[11px]">{active ? t('agentUnselect') : t('agentSelect')}</span>
                  </button>
                )
              })}
            </div>
          </section>
        </aside>

        <section className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-3 text-sm font-medium">{t('agentSelectedFiles')}</h2>
            {selected.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('agentNoFiles')}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {selected.map(file => (
                  <Badge key={file} variant="outline" className="max-w-full gap-1">
                    <span className="truncate">{file}</span>
                    <button type="button" onClick={() => toggleFile(file)} aria-label={t('agentUnselect')}>
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4">
            <label className="mb-2 block text-sm font-medium">{t('agentPrompt')}</label>
            <Textarea
              value={message}
              onChange={event => setMessage(event.target.value)}
              placeholder={t('agentPromptPlaceholder')}
              className="min-h-[150px]"
            />
            <div className="mt-3 flex items-center justify-end">
              <Button onClick={runAgent} disabled={!message.trim() || ask.isPending}>
                <Bot />
                {ask.isPending ? t('agentRunning') : t('agentRun')}
              </Button>
            </div>
            {ask.isError && (
              <p className="mt-3 text-sm text-destructive">{(ask.error as Error).message}</p>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">{t('agentResponse')}</h2>
              {reply?.routedVia && (
                <span className="text-xs text-muted-foreground">
                  {t('agentRoutedVia')} {reply.routedVia.platform}/{reply.routedVia.model}
                </span>
              )}
            </div>
            {reply ? (
              <div className="whitespace-pre-wrap text-sm leading-relaxed">{reply.content}</div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('agentNoResponse')}</p>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
