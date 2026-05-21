import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Clipboard,
  ExternalLink,
  KeyRound,
  MessageSquare,
  RefreshCw,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/page-header'
import { useI18n } from '@/lib/i18n'
import type { ApiKey, Platform } from '../../../shared/types'

type ProviderGuide = {
  platform: Platform
  name: string
  accountUrl: string
  keyUrl: string
  freeTierKey: string
  credentialLabel: string
  placeholder: string
  noteKey: string
  accountId?: boolean
  optionalKey?: boolean
}

const PROVIDERS: ProviderGuide[] = [
  {
    platform: 'google',
    name: 'Google AI Studio',
    accountUrl: 'https://ai.google.dev',
    keyUrl: 'https://aistudio.google.com/api-keys',
    freeTierKey: 'providerGoogleTier',
    credentialLabel: 'API key',
    placeholder: 'AIza...',
    noteKey: 'providerGoogleNote',
  },
  {
    platform: 'groq',
    name: 'Groq',
    accountUrl: 'https://console.groq.com',
    keyUrl: 'https://console.groq.com/keys',
    freeTierKey: 'providerGroqTier',
    credentialLabel: 'API key',
    placeholder: 'gsk_...',
    noteKey: 'providerGroqNote',
  },
  {
    platform: 'cerebras',
    name: 'Cerebras',
    accountUrl: 'https://cloud.cerebras.ai',
    keyUrl: 'https://cloud.cerebras.ai/platform',
    freeTierKey: 'providerCerebrasTier',
    credentialLabel: 'API key',
    placeholder: 'csk-...',
    noteKey: 'providerCerebrasNote',
  },
  {
    platform: 'sambanova',
    name: 'SambaNova',
    accountUrl: 'https://cloud.sambanova.ai',
    keyUrl: 'https://cloud.sambanova.ai/apis',
    freeTierKey: 'providerSambanovaTier',
    credentialLabel: 'API key',
    placeholder: 'sambanova...',
    noteKey: 'providerSambanovaNote',
  },
  {
    platform: 'nvidia',
    name: 'NVIDIA NIM',
    accountUrl: 'https://build.nvidia.com',
    keyUrl: 'https://build.nvidia.com',
    freeTierKey: 'providerNvidiaTier',
    credentialLabel: 'API key',
    placeholder: 'nvapi-...',
    noteKey: 'providerNvidiaNote',
  },
  {
    platform: 'mistral',
    name: 'Mistral',
    accountUrl: 'https://console.mistral.ai',
    keyUrl: 'https://console.mistral.ai/api-keys',
    freeTierKey: 'providerMistralTier',
    credentialLabel: 'API key',
    placeholder: '...',
    noteKey: 'providerMistralNote',
  },
  {
    platform: 'openrouter',
    name: 'OpenRouter',
    accountUrl: 'https://openrouter.ai',
    keyUrl: 'https://openrouter.ai/settings/keys',
    freeTierKey: 'providerOpenrouterTier',
    credentialLabel: 'API key',
    placeholder: 'sk-or-v1-...',
    noteKey: 'providerOpenrouterNote',
  },
  {
    platform: 'github',
    name: 'GitHub Models',
    accountUrl: 'https://github.com/marketplace/models',
    keyUrl: 'https://github.com/settings/personal-access-tokens',
    freeTierKey: 'providerGithubTier',
    credentialLabel: 'GitHub token',
    placeholder: 'github_pat_...',
    noteKey: 'providerGithubNote',
  },
  {
    platform: 'cohere',
    name: 'Cohere',
    accountUrl: 'https://dashboard.cohere.com',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    freeTierKey: 'providerCohereTier',
    credentialLabel: 'API key',
    placeholder: '...',
    noteKey: 'providerCohereNote',
  },
  {
    platform: 'cloudflare',
    name: 'Cloudflare Workers AI',
    accountUrl: 'https://dash.cloudflare.com',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    freeTierKey: 'providerCloudflareTier',
    credentialLabel: 'API token',
    placeholder: 'token...',
    accountId: true,
    noteKey: 'providerCloudflareNote',
  },
  {
    platform: 'zhipu',
    name: 'Z.ai / Zhipu',
    accountUrl: 'https://bigmodel.cn',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    freeTierKey: 'providerZhipuTier',
    credentialLabel: 'API key',
    placeholder: '...',
    noteKey: 'providerZhipuNote',
  },
  {
    platform: 'ollama',
    name: 'Ollama Cloud',
    accountUrl: 'https://ollama.com',
    keyUrl: 'https://ollama.com/settings/keys',
    freeTierKey: 'providerOllamaTier',
    credentialLabel: 'API key',
    placeholder: 'ollama_...',
    noteKey: 'providerOllamaNote',
  },
  {
    platform: 'kilo',
    name: 'Kilo Gateway',
    accountUrl: 'https://kilo.ai',
    keyUrl: 'https://kilo.ai',
    freeTierKey: 'providerKiloTier',
    credentialLabel: 'API key',
    placeholder: 'optional key or anonymous',
    optionalKey: true,
    noteKey: 'providerKiloNote',
  },
  {
    platform: 'pollinations',
    name: 'Pollinations',
    accountUrl: 'https://pollinations.ai',
    keyUrl: 'https://pollinations.ai',
    freeTierKey: 'providerPollinationsTier',
    credentialLabel: 'Token',
    placeholder: 'anonymous',
    optionalKey: true,
    noteKey: 'providerPollinationsNote',
  },
  {
    platform: 'llm7',
    name: 'LLM7',
    accountUrl: 'https://llm7.io',
    keyUrl: 'https://llm7.io',
    freeTierKey: 'providerLlm7Tier',
    credentialLabel: 'API key',
    placeholder: 'optional key or anonymous',
    optionalKey: true,
    noteKey: 'providerLlm7Note',
  },
]

type Drafts = Record<string, { key: string; accountId: string; label: string }>

const statusTone: Record<string, string> = {
  healthy: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
  rate_limited: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
  invalid: 'border-rose-500/40 text-rose-700 dark:text-rose-300',
  error: 'border-rose-500/40 text-rose-700 dark:text-rose-300',
  unknown: 'border-border text-muted-foreground',
}

function emptyDrafts(): Drafts {
  return Object.fromEntries(
    PROVIDERS.map(provider => [
      provider.platform,
      {
        key: provider.optionalKey ? 'anonymous' : '',
        accountId: '',
        label: provider.name,
      },
    ]),
  )
}

export default function OnboardingPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [drafts, setDrafts] = useState<Drafts>(() => emptyDrafts())
  const [copied, setCopied] = useState(false)

  const { data: keys = [] } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: unifiedKey } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const addKey = useMutation({
    mutationFn: (body: { platform: Platform; key: string; label?: string }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })

  const configuredByPlatform = useMemo(() => {
    const map = new Map<Platform, ApiKey[]>()
    for (const key of keys) {
      const list = map.get(key.platform) ?? []
      list.push(key)
      map.set(key.platform, list)
    }
    return map
  }, [keys])

  const configuredCount = PROVIDERS.filter(provider => configuredByPlatform.has(provider.platform)).length
  const ready = configuredCount > 0
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`

  function updateDraft(platform: Platform, field: 'key' | 'accountId' | 'label', value: string) {
    setDrafts(prev => ({
      ...prev,
      [platform]: {
        ...prev[platform],
        [field]: value,
      },
    }))
  }

  function saveProvider(provider: ProviderGuide) {
    const draft = drafts[provider.platform]
    const rawKey = draft.key.trim()
    const accountId = draft.accountId.trim()
    if (!rawKey || (provider.accountId && !accountId)) return
    const key = provider.accountId ? `${accountId}:${rawKey}` : rawKey
    addKey.mutate({
      platform: provider.platform,
      key,
      label: draft.label.trim() || provider.name,
    })
  }

  function copyApiSetup() {
    const text = `base_url=${baseUrl}\napi_key=${unifiedKey?.apiKey ?? ''}`
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div>
      <PageHeader
        title={t('onboardingTitle')}
        description={t('onboardingDescription')}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => checkAll.mutate()} disabled={!ready || checkAll.isPending}>
              <RefreshCw />
              {checkAll.isPending ? t('verifying') : t('verify')}
            </Button>
            <Button size="sm" render={<Link to="/playground" />}>
              <MessageSquare />
              Chatbot
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <section className="space-y-3">
          {PROVIDERS.map(provider => {
            const providerKeys = configuredByPlatform.get(provider.platform) ?? []
            const firstStatus = providerKeys[0]?.status ?? 'unknown'
            const draft = drafts[provider.platform]
            const canSave = Boolean(draft.key.trim()) && (!provider.accountId || Boolean(draft.accountId.trim()))

            return (
              <div key={provider.platform} className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex-1 min-w-[220px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-medium">{provider.name}</h2>
                      <Badge variant="outline">{t(provider.freeTierKey)}</Badge>
                      {providerKeys.length > 0 && (
                        <Badge variant="outline" className={statusTone[firstStatus] ?? statusTone.unknown}>
                          <Check className="size-3" />
                          {providerKeys.length} {providerKeys.length > 1 ? t('connectedKeys') : t('connectedKey')}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{t(provider.noteKey)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" render={<a href={provider.accountUrl} target="_blank" rel="noreferrer" />}>
                      {t('account')}
                      <ExternalLink />
                    </Button>
                    <Button variant="outline" size="sm" render={<a href={provider.keyUrl} target="_blank" rel="noreferrer" />}>
                      {t('key')}
                      <ExternalLink />
                    </Button>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(180px,220px)_auto]">
                  {provider.accountId && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('accountId')}</Label>
                      <Input
                        value={draft.accountId}
                        onChange={event => updateDraft(provider.platform, 'accountId', event.target.value)}
                        placeholder={t('cloudflareAccountPlaceholder')}
                        className="font-mono text-xs"
                      />
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label className="text-xs">{provider.credentialLabel}</Label>
                    <Input
                      type={provider.optionalKey ? 'text' : 'password'}
                      value={draft.key}
                      onChange={event => updateDraft(provider.platform, 'key', event.target.value)}
                      placeholder={provider.placeholder}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t('label')}</Label>
                    <Input
                      value={draft.label}
                      onChange={event => updateDraft(provider.platform, 'label', event.target.value)}
                      placeholder={t('providerLabelPlaceholder')}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      size="sm"
                      onClick={() => saveProvider(provider)}
                      disabled={!canSave || addKey.isPending}
                    >
                      <KeyRound />
                      {t('add')}
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </section>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <section className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-medium">{t('progress')}</h2>
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('connectedProviders')}</span>
                <span className="tabular-nums">{configuredCount}/{PROVIDERS.length}</span>
              </div>
              <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.max(4, (configuredCount / PROVIDERS.length) * 100)}%` }}
                />
              </div>
            </div>
            <div className="mt-4 space-y-2 text-sm text-muted-foreground">
              <p>{t('progressHintOne')}</p>
              <p>{t('progressHintTwo')}</p>
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-medium">{t('chatbotConfig')}</h2>
            <div className="mt-3 space-y-2 text-xs">
              <div>
                <span className="text-muted-foreground">Base URL</span>
                <code className="mt-1 block truncate rounded-md bg-muted px-2 py-1.5">{baseUrl}</code>
              </div>
              <div>
                <span className="text-muted-foreground">API key</span>
                <code className="mt-1 block truncate rounded-md bg-muted px-2 py-1.5">
                  {unifiedKey?.apiKey ? `${unifiedKey.apiKey.slice(0, 13)}********************************` : '...'}
                </code>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="outline" size="sm" onClick={copyApiSetup} disabled={!unifiedKey?.apiKey}>
                <Clipboard />
                {copied ? t('copied') : t('copy')}
              </Button>
              <Button size="sm" render={<Link to="/playground" />}>
                {t('test')}
              </Button>
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-medium">{t('recommendedOrder')}</h2>
            <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>{t('orderOne')}</li>
              <li>{t('orderTwo')}</li>
              <li>{t('orderThree')}</li>
              <li>{t('orderFour')}</li>
            </ol>
          </section>
        </aside>
      </div>

      {addKey.isError && (
        <p className="mt-4 text-sm text-destructive">{(addKey.error as Error).message}</p>
      )}
    </div>
  )
}
