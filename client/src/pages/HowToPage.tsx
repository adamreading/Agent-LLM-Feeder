import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

const mono = { fontFamily: "'JetBrains Mono',monospace" } as const
const panel: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--panel)', padding: 20 }

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ position: 'relative', marginTop: 10 }}>
      <button
        onClick={() => { navigator.clipboard?.writeText(children).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
        className="cy-hover-acc"
        style={{ all: 'unset', cursor: 'pointer', position: 'absolute', top: 8, right: 8, ...mono, fontSize: 9, letterSpacing: 1, color: 'var(--dim)', border: '1px solid var(--line)', padding: '2px 6px' }}
      >{copied ? 'COPIED ✓' : 'COPY'}</button>
      <pre style={{ margin: 0, ...mono, fontSize: 12, color: 'var(--ink)', background: 'var(--bg2)', border: '1px solid var(--line)', padding: '12px 14px', overflowX: 'auto', lineHeight: 1.5 }}>{children}</pre>
    </div>
  )
}

function Section({ step, title, children }: { step: string; title: string; children: React.ReactNode }) {
  return (
    <section style={panel}>
      <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 2, marginBottom: 4 }}>{step}</div>
      <h2 style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 700, letterSpacing: 1 }}>{title}</h2>
      {children}
    </section>
  )
}

const P: React.CSSProperties = { fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.6, margin: '0 0 8px' }
const acc = { color: 'var(--acc)' }

export default function HowToPage() {
  const { data } = useQuery<{ apiKey: string }>({ queryKey: ['unified-key'], queryFn: () => apiFetch('/api/settings/api-key') })
  const key = data?.apiKey ?? 'freellmapi-…'
  const base = 'http://localhost:3001/v1'

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '36px 28px 80px', animation: 'flickin .35s ease' }}>
      <div style={{ ...mono, fontSize: 10, color: 'var(--acc2)', letterSpacing: 3, marginBottom: 6 }}>// JACK ANY AGENT INTO THE ROUTER</div>
      <h1 style={{ margin: '0 0 6px', fontSize: 40, fontWeight: 700, letterSpacing: 1, textShadow: '0 0 24px var(--glow)' }}>HOW TO CONNECT</h1>
      <p style={{ ...P, color: 'var(--dim)', maxWidth: 640, marginBottom: 22 }}>
        Feeder is an <span style={acc}>OpenAI-compatible</span> endpoint. Anything that speaks the OpenAI Chat Completions API — Open WebUI, an agent framework, a script, curl — points at it with one key and gets the best free model for the job, with automatic failover.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Section step="// THE ENDPOINT" title="One base URL, one key">
          <p style={P}>Every request uses your <span style={acc}>unified key</span> (from the Key Vault) as the Bearer token. Provider keys stay encrypted behind it — the caller never sees them.</p>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', ...mono, fontSize: 12, color: 'var(--dim)', marginTop: 6 }}>
            <span>BASE_URL <span style={{ color: 'var(--ink)' }}>{base}</span></span>
            <span>MODELS <span style={{ color: 'var(--ink)' }}>GET /v1/models</span></span>
          </div>
          <div style={{ ...mono, fontSize: 12, color: 'var(--dim)', marginTop: 6 }}>KEY <span style={{ color: 'var(--acc2)' }}>{key.slice(0, 16)}…</span> <span style={{ color: 'var(--dim)' }}>(full key on the Key Vault page)</span></div>
        </Section>

        <Section step="// SMOKE TEST" title="A first request">
          <p style={P}>Send <span style={acc}>no model</span> (or <span style={acc}>"auto"</span>) and the router picks the best available free model, failing over on rate limits:</p>
          <Code>{`curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [{"role": "user", "content": "Say hi in 3 words."}]
  }'`}</Code>
          <p style={{ ...P, marginTop: 10 }}>Pin an exact model with <span style={acc}>platform/model_id</span> (e.g. <span style={mono}>sambanova/gpt-oss-120b</span>) — see the Models page for what's available.</p>
        </Section>

        <Section step="// ROUTING CONTROLS" title="Optional request fields">
          <p style={P}>Beyond the standard OpenAI fields, feeder accepts a few extras to steer routing. All optional — omit them and you get sensible defaults.</p>
          <Code>{`{
  "messages": [ ... ],
  "needs": ["tools", "long_context"],   // only route to models measured to support these
  "latency_ceiling_ms": 8000,            // prefer fast models; skip slow ones
  "exclude_reasoning": true,             // strip raw chain-of-thought from the reply
  "exclude_providers": ["openrouter"],   // never use these platforms for this call
  "max_attempts": 4,                     // cap failover hops
  "session_id": "conversation-123"       // sticky: keep a conversation on one model
}`}</Code>
          <p style={{ ...P, marginTop: 10 }}>On no eligible model feeder returns a typed <span style={mono}>422 NO_ELIGIBLE_MODEL</span>; when everything's rate-limited, <span style={mono}>429 ALL_RATE_LIMITED</span> — so a caller can fall back to its own local/pinned option rather than get a silently-wrong model.</p>
        </Section>

        <Section step="// OPEN WEBUI" title="Add as an OpenAI connection">
          <p style={P}>In Open WebUI: <span style={acc}>Settings → Connections → OpenAI API → +</span>. Then:</p>
          <div style={{ ...mono, fontSize: 12, color: 'var(--dim)', marginTop: 6, lineHeight: 1.8 }}>
            <div>API Base URL <span style={{ color: 'var(--ink)' }}>{base}</span></div>
            <div>API Key <span style={{ color: 'var(--ink)' }}>your unified key</span></div>
          </div>
          <p style={{ ...P, marginTop: 10 }}>Feeder's models then appear in Open WebUI's model picker (from <span style={mono}>GET /v1/models</span>). Pick a specific one, or add a model literally named <span style={mono}>auto</span> to let the router choose.</p>
        </Section>

        <Section step="// AGENTS" title="Wire an agent (e.g. a Hermes-style agent)">
          <p style={P}>Register feeder as a custom OpenAI-compatible provider in your agent framework — base URL + unified key — and have each call-site declare what it actually needs via <span style={acc}>extra_body</span>. Example for an agentic, tool-using chat turn:</p>
          <Code>{`# provider config
base_url: http://localhost:3001/v1
api_key: <your unified key>
model: auto                # let feeder route; or pin platform/model_id

# per-call extra_body (what THIS call-site requires)
extra_body:
  needs: ["tools", "long_context"]
  exclude_reasoning: true
  latency_ceiling_ms: 8000`}</Code>
          <p style={{ ...P, marginTop: 10 }}>Because <span style={acc}>needs[]</span> is caller-declared, feeder never has to know anything about your agent — it just honours what each call-site asks for and refuses cleanly (422) if nothing qualifies, so your agent can fall back to a local model.</p>
        </Section>

        <Section step="// SYSTEM PROMPT" title="Example agent system prompt">
          <p style={P}>Feeder is model-agnostic, so bake your persona/behaviour into the system message — it travels with every request whichever model serves it. A minimal starting point:</p>
          <Code>{`You are <AGENT NAME>, a helpful assistant.
- Always respond in English.
- Be concise and direct; do not narrate your reasoning.
- When a tool is available and relevant, call it rather than guessing.
- If you cannot complete a request, say so plainly.`}</Code>
          <p style={{ ...P, marginTop: 10 }}>The "respond in English / don't narrate reasoning" lines matter when routing across many models — pair them with <span style={mono}>exclude_reasoning: true</span> so raw chain-of-thought never reaches your users.</p>
        </Section>
      </div>
    </main>
  )
}
