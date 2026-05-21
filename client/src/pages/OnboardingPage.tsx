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
import type { ApiKey, Platform } from '../../../shared/types'

type ProviderGuide = {
  platform: Platform
  name: string
  accountUrl: string
  keyUrl: string
  freeTier: string
  credentialLabel: string
  placeholder: string
  note: string
  accountId?: boolean
  optionalKey?: boolean
}

const PROVIDERS: ProviderGuide[] = [
  {
    platform: 'google',
    name: 'Google AI Studio',
    accountUrl: 'https://ai.google.dev',
    keyUrl: 'https://aistudio.google.com/api-keys',
    freeTier: 'Gemini free tier',
    credentialLabel: 'API key',
    placeholder: 'AIza...',
    note: 'Create a Gemini API key in AI Studio, then paste it here.',
  },
  {
    platform: 'groq',
    name: 'Groq',
    accountUrl: 'https://console.groq.com',
    keyUrl: 'https://console.groq.com/keys',
    freeTier: 'Free developer quota',
    credentialLabel: 'API key',
    placeholder: 'gsk_...',
    note: 'Use the Groq console key for OpenAI-compatible chat completions.',
  },
  {
    platform: 'cerebras',
    name: 'Cerebras',
    accountUrl: 'https://cloud.cerebras.ai',
    keyUrl: 'https://cloud.cerebras.ai/platform',
    freeTier: 'Free inference tier',
    credentialLabel: 'API key',
    placeholder: 'csk-...',
    note: 'Create a platform key from Cerebras Cloud.',
  },
  {
    platform: 'sambanova',
    name: 'SambaNova',
    accountUrl: 'https://cloud.sambanova.ai',
    keyUrl: 'https://cloud.sambanova.ai/apis',
    freeTier: 'Free cloud access',
    credentialLabel: 'API key',
    placeholder: 'sambanova...',
    note: 'Use the API key from SambaNova Cloud.',
  },
  {
    platform: 'nvidia',
    name: 'NVIDIA NIM',
    accountUrl: 'https://build.nvidia.com',
    keyUrl: 'https://build.nvidia.com',
    freeTier: 'Developer trial credits',
    credentialLabel: 'API key',
    placeholder: 'nvapi-...',
    note: 'The repository keeps NVIDIA disabled by default in some flows; add a key only if your account has active quota.',
  },
  {
    platform: 'mistral',
    name: 'Mistral',
    accountUrl: 'https://console.mistral.ai',
    keyUrl: 'https://console.mistral.ai/api-keys',
    freeTier: 'La Plateforme trial/free access',
    credentialLabel: 'API key',
    placeholder: '...',
    note: 'Generate a key from La Plateforme and watch the console limits.',
  },
  {
    platform: 'openrouter',
    name: 'OpenRouter',
    accountUrl: 'https://openrouter.ai',
    keyUrl: 'https://openrouter.ai/settings/keys',
    freeTier: 'Models tagged :free',
    credentialLabel: 'API key',
    placeholder: 'sk-or-v1-...',
    note: 'Use OpenRouter free models through the router fallback chain.',
  },
  {
    platform: 'github',
    name: 'GitHub Models',
    accountUrl: 'https://github.com/marketplace/models',
    keyUrl: 'https://github.com/settings/personal-access-tokens',
    freeTier: 'GitHub Models free limits',
    credentialLabel: 'GitHub token',
    placeholder: 'github_pat_...',
    note: 'Create a token that can access GitHub Models inference.',
  },
  {
    platform: 'cohere',
    name: 'Cohere',
    accountUrl: 'https://dashboard.cohere.com',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    freeTier: 'Trial API access',
    credentialLabel: 'API key',
    placeholder: '...',
    note: 'Cohere is routed through its OpenAI-compatible endpoint.',
  },
  {
    platform: 'cloudflare',
    name: 'Cloudflare Workers AI',
    accountUrl: 'https://dash.cloudflare.com',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    freeTier: 'Workers AI free allocation',
    credentialLabel: 'API token',
    placeholder: 'token...',
    accountId: true,
    note: 'Cloudflare needs both your account ID and API token; this app stores them as account_id:token.',
  },
  {
    platform: 'zhipu',
    name: 'Z.ai / Zhipu',
    accountUrl: 'https://bigmodel.cn',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    freeTier: 'GLM free or trial quota',
    credentialLabel: 'API key',
    placeholder: '...',
    note: 'Use the BigModel API key for GLM models.',
  },
  {
    platform: 'ollama',
    name: 'Ollama Cloud',
    accountUrl: 'https://ollama.com',
    keyUrl: 'https://ollama.com/settings/keys',
    freeTier: 'Free cloud sessions',
    credentialLabel: 'API key',
    placeholder: 'ollama_...',
    note: 'Only add models that your Ollama plan can run.',
  },
  {
    platform: 'kilo',
    name: 'Kilo Gateway',
    accountUrl: 'https://kilo.ai',
    keyUrl: 'https://kilo.ai',
    freeTier: 'Anonymous or keyed free requests',
    credentialLabel: 'API key',
    placeholder: 'optional key or anonymous',
    optionalKey: true,
    note: 'Anonymous use is supported by the upstream provider; save "anonymous" if you do not have a key.',
  },
  {
    platform: 'pollinations',
    name: 'Pollinations',
    accountUrl: 'https://pollinations.ai',
    keyUrl: 'https://pollinations.ai',
    freeTier: 'Anonymous public access',
    credentialLabel: 'Token',
    placeholder: 'anonymous',
    optionalKey: true,
    note: 'The public endpoint can be used anonymously; save "anonymous" to enable it in the router.',
  },
  {
    platform: 'llm7',
    name: 'LLM7',
    accountUrl: 'https://llm7.io',
    keyUrl: 'https://llm7.io',
    freeTier: 'Anonymous or keyed free requests',
    credentialLabel: 'API key',
    placeholder: 'optional key or anonymous',
    optionalKey: true,
    note: 'Anonymous access is supported for basic usage; a real key can raise limits.',
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
        title="Embarquement"
        description="Creez les comptes free tier, ajoutez les cles API, puis lancez le chatbot sur le routeur local."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => checkAll.mutate()} disabled={!ready || checkAll.isPending}>
              <RefreshCw />
              {checkAll.isPending ? 'Verification...' : 'Verifier'}
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
                      <Badge variant="outline">{provider.freeTier}</Badge>
                      {providerKeys.length > 0 && (
                        <Badge variant="outline" className={statusTone[firstStatus] ?? statusTone.unknown}>
                          <Check className="size-3" />
                          {providerKeys.length} cle{providerKeys.length > 1 ? 's' : ''}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{provider.note}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" render={<a href={provider.accountUrl} target="_blank" rel="noreferrer" />}>
                      Compte
                      <ExternalLink />
                    </Button>
                    <Button variant="outline" size="sm" render={<a href={provider.keyUrl} target="_blank" rel="noreferrer" />}>
                      Cle
                      <ExternalLink />
                    </Button>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(180px,220px)_auto]">
                  {provider.accountId && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Account ID</Label>
                      <Input
                        value={draft.accountId}
                        onChange={event => updateDraft(provider.platform, 'accountId', event.target.value)}
                        placeholder="cloudflare account id"
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
                    <Label className="text-xs">Libelle</Label>
                    <Input
                      value={draft.label}
                      onChange={event => updateDraft(provider.platform, 'label', event.target.value)}
                      placeholder={provider.name}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      size="sm"
                      onClick={() => saveProvider(provider)}
                      disabled={!canSave || addKey.isPending}
                    >
                      <KeyRound />
                      Ajouter
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </section>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <section className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-medium">Progression</h2>
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Fournisseurs connectes</span>
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
              <p>Une seule cle suffit pour lancer le chatbot. Ajoutez-en plusieurs pour profiter du fallback automatique.</p>
              <p>Les cles fournisseur sont chiffrees en SQLite; vos apps utilisent uniquement la cle unifiee.</p>
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-medium">Configuration chatbot</h2>
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
                {copied ? 'Copie' : 'Copier'}
              </Button>
              <Button size="sm" render={<Link to="/playground" />}>
                Tester
              </Button>
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-medium">Ordre conseille</h2>
            <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>1. Creez un compte chez un ou plusieurs fournisseurs.</li>
              <li>2. Generez une cle API free tier.</li>
              <li>3. Ajoutez la cle ici, puis lancez une verification.</li>
              <li>4. Ouvrez le chatbot et envoyez un premier message.</li>
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
