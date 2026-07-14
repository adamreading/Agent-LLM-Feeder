# Agent-LLM-Feeder

**An agent-agnostic, OpenAI-compatible intelligent supply of free-tier LLMs.**

Point any OpenAI-compatible client — an agent framework, Open WebUI, a script, curl — at one local endpoint with one key, and get served the *right* free model for each request, with automatic, capability-honest failover across every free-tier provider you've connected.

It behaves like LiteLLM/Ollama as a drop-in OpenAI endpoint, but adds a precomputed intelligence layer: it knows (from live probes and web research) what each model can actually do and how fast/healthy each supplier is right now, and routes accordingly — without passing your prompt through an extra LLM to decide.

> Based on the open-source [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) router (multi-provider fallback, encrypted key storage, health checks), evolved into an intelligent, capability-aware routing layer with a Postgres store, a model wiki, per-model web research, and a health/latency-aware selection engine. It is **agent-agnostic**: no consumer-specific policy lives in the router — callers declare what they need.

---

## What it does

- **Single endpoint.** `POST /v1/chat/completions` — the standard OpenAI shape. Omit `model` (or send `"auto"`) to let the router choose; pin `platform/model_id` to force one.
- **Capability-honest routing.** A request that declares `needs: ["tools", ...]` only ever lands on a model *measured* (not just claimed) to support it. If nothing qualifies, you get a typed `422 NO_ELIGIBLE_MODEL` — never a silently-wrong model.
- **Health & latency aware.** Within the eligible set, the router prefers fast, healthy suppliers and circuit-breaks ones that just timed out or rate-limited, so failover doesn't re-pay a dead provider's timeout. Latency's weight scales with the caller's declared `latency_ceiling_ms`.
- **Automatic failover.** Rate-limited / erroring providers are skipped; the request walks the eligible set until one succeeds, or returns a typed `429 ALL_RATE_LIMITED`.
- **Model wiki.** A browsable, searchable catalogue: every model grouped across the suppliers that offer it, with measured capabilities, live per-supplier health/latency, and a web-researched summary + per-task quality scores.
- **Web UI** for onboarding providers, managing keys, browsing the model wiki, a chat playground, fallback ordering, analytics, and a How-To.
- **Encrypted key storage** (AES-256-GCM). Provider keys never leave the machine and are never exposed to callers — they authenticate with a single unified key.

---

## Architecture

```
client/   React + Vite web UI (the cyberpunk "AGENT//FEEDER" interface)
server/   Express + TypeScript API, the router, providers, probes, research
shared/   Types shared between client and server
```

- **Store:** local **Postgres** (Drizzle ORM). Holds the model catalogue, per-model measured capabilities, canonical-model grouping, per-task quality scores, live model health, quota snapshots, request logs, consumer keys, and the policy matrix.
- **Providers:** each supplier is a `BaseProvider` adapter (`server/src/providers/`) that translates the OpenAI shape to the provider's wire format (tools, JSON mode, reasoning control, context length, schema quirks — e.g. the Gemini schema sanitizer).
- **Router:** `server/src/services/router.ts` — filters the catalogue by capability/cost/context/latency (fresh per attempt), orders the survivors by a health × latency × quality score, and returns the pick. Pure filtered-SQL-sort; no inline LLM decision.
- **Probes:** `server/src/services/probes/` — actively test each model on the wire (tools, JSON mode, long-context needle recall, reachability) and record `source='measured'` capability facts. Hard routing gates trust `measured` only, never `declared`.
- **Research:** `server/src/services/modelResearch.ts` — web-searches each model and has one of your own models write a summary + per-task scores (see below).

---

## Quick start

**Prerequisites:** Node 20+, a local Postgres instance, and at least one free-tier provider API key.

```bash
# 1. Install
npm install

# 2. Configure — copy the example and fill in ENCRYPTION_KEY + DATABASE_URL
cp .env.example .env
#    generate an encryption key:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#    create the database (example): createdb feeder

# 3. Apply the schema
cd server && npx drizzle-kit migrate && cd ..

# 3b. (Optional) Import the curated wiki seed — a real starting-point dataset of
#     ~210 canonical models with researched summaries, task scores, measured
#     capabilities, context windows, and per-provider free-tier rate limits.
#     Idempotent, natural-key keyed, no secrets. (Regenerate with seed:wiki:export.)
cd server && npm run seed:wiki:import && cd ..

# 4. Run the server (serves the API on :3001 and, in prod, the built UI)
cd server && npm run dev        # or: npm run build && npm start

# 5. Run the web UI (dev) — Vite on :5173, proxies /api + /v1 to :3001
cd client && npm run dev
```

Open the UI, go to **Onboarding**, add one or more provider keys, then use the **Chatbot** page or hit the endpoint directly (see **Using the endpoint**).

> The server seeds/updates the model catalogue on startup and auto-groups models into the wiki's canonical entries. One valid key is enough to start; more keys = more failover headroom.

---

## Configuration (`.env`)

| Variable | Required | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | ✅ | 64-char hex; encrypts stored provider keys (AES-256-GCM). |
| `DATABASE_URL` | ✅ | Postgres connection string for the feeder database. |
| `PORT` | – | API port (default `3001`). |
| `WEB_SEARCH_BACKEND` | – | Web-search backend for model research (default `ollama`). |
| `OLLAMA_API_KEY` | – | Key for the Ollama hosted web-search API (needed when the backend is `ollama`). |
| `RESEARCH_MODEL` | – | `platform/model_id` of the model that writes research summaries. If unset, the smartest reachable JSON-capable keyed model is auto-picked. |

`.env` is gitignored — never commit real keys.

---

## The web UI

Cyberpunk-themed, with three switchable colour "flavors" (holo / noir / acid) and a CRT-scanlines toggle in the header.

| Page | What it's for |
|---|---|
| **Onboarding** | Guided links to grab free-tier keys from each provider, with a connect-progress bar. |
| **Model Wiki** (`/wiki`) | Every model, grouped across suppliers, with capability pills, arena scores, and a per-model detail page (capability matrix, task scores, served-by table with live latency). |
| **Chatbot** | A playground to chat through the router (auto or a pinned model), showing which model served each turn + its classified task class + latency + fallback hops, with Markdown/LaTeX rendering. A **WEB** toggle (shown when a search provider is onboarded) opts the chat into web-search grounding via the configured backend; turns that were grounded show a `web` badge. |
| **Agent** | Browse **any directory on the host** (WSL + mounted Windows drives), attach text files or images as context, and task the router. Same controls as the Chatbot: model dropdown (Auto or a pinned model), a **WEB** search toggle, and Markdown/LaTeX rendering. Attaching an image routes to a vision-capable model. **Save** a response to a file (`.md`/`.txt`/`.pdf`) in the repo-local `tmp/` dir and **download** it from the UI. **Thumbs up/down** on a response records content-free feedback; repeated image down-votes on a model demote its vision capability. Filesystem access is authenticated, read-only (writes disabled), and blocks secret files (`.env`, keys, credentials). |
| **Key Vault** | Manage the unified key + per-provider keys, with live health/status. |
| **Fallback** | Drag-to-reorder the fallback chain, toggle models, and view the monthly token budget. |
| **Analytics** | Requests / latency / errors over time, per provider and per model. |
| **How To** | How to connect any external client/agent to the endpoint (also summarised below). |

---

## Using the endpoint

Feeder is a standard **OpenAI Chat Completions** endpoint.

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer <your unified key>" \
  -H "Content-Type: application/json" \
  -d '{ "messages": [{"role":"user","content":"Say hi in 3 words."}] }'
```

- **Auth:** the **unified key** (from the Key Vault) as the Bearer token. Provider keys stay encrypted behind it. (A tokenless request from localhost is trusted as fleet.)
- **Model:** omit or `"auto"` to let the router choose; or pin `"platform/model_id"` (e.g. `sambanova/gpt-oss-120b`). A bare model id that exists on multiple platforms returns `400 model_ambiguous` — pin the platform.
  - A **bare `"auto"`** request is classified from the prompt (coding / math / reasoning / creative / trivial) so routing engages the right per-task quality scores. An explicit `"auto/<class>"` is honoured verbatim and skips classification.
- **Model list:** `GET /v1/models` — each entry includes `supported_parameters`, the sampling/generation params that model's provider will actually honour.
- **Response attribution:** the resolved model is returned as the `X-Routed-Via` header and stamped into the body (`model` / `_routed_via`); on streams it's on each `chunk.model`. The classified task class is returned as the `X-Task-Class` header and `_task_class` body field (and `chunk._task_class` on streams) — `overall` / `null` when unclassified. When web-search grounding was injected, `X-Augmented: web-search` is set.

### Sampling / generation params

Standard OpenAI params are passed through when set (unset ones are never sent, so the default request is unchanged): `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `frequency_penalty`, `presence_penalty`, `seed`, `stop`, `n`, `logit_bias`, `logprobs`, `top_logprobs`. Vendor params (`top_k`, `min_p`, `repetition_penalty`) are forwarded only to providers documented to accept them (e.g. OpenRouter); other providers omit them rather than error. A provider known to reject a specific param has it stripped (`dropParams`).

### Vision / multimodal

A user message's `content` may be an array of parts mixing text and images, in the standard OpenAI shape:

```json
{ "model": "auto", "messages": [{ "role": "user", "content": [
  { "type": "text", "text": "What is in this image?" },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
]}]}
```

An image part adds `vision` as a hard capability need automatically, so a bare-`auto` image request routes to a vision-capable model. `image_url.url` may be a `data:` URI (base64) or an `http(s)` URL — Gemini needs inline base64 (URL images route to OpenAI-compat vision models, which accept URLs natively). Vision eligibility uses a **relaxed gate**: a research-declared vision model is tried, then confirmed (`observed=true`) on success or demoted (`observed=false`) on a genuine image rejection — never on a transient 429/timeout.

The request body limit is **25 MB** (raised from 1 MB) so inline base64 images fit — a ~18 MB image is ~24 MB base64. Callers are auth-gated, so this is safe for this non-public endpoint.

### Optional routing fields

All optional; omit for sensible defaults.

| Field | Effect |
|---|---|
| `needs: string[]` | Only route to models that support every listed capability (e.g. `["tools","long_context"]`). Most capabilities require *measured/observed* evidence (never a spec-sheet claim); `vision` is the exception — a research-*declared* vision model is tried, then confirmed/demoted from real use. |
| `latency_ceiling_ms: number` | Prefer fast models; exclude ones whose historical p95 exceeds this. Also weights the ranker toward speed. |
| `exclude_reasoning: boolean` | Strip raw chain-of-thought from the reply (never fold it into content). |
| `exclude_providers: string[]` | Never use these platforms for this call. |
| `max_attempts: number` | Cap failover hops (≤20). |
| `session_id` / `user` | Sticky routing — keep one conversation on one model across turns. |
| `consumer: string` (or `X-Consumer` header) | Attribution label for the request log (e.g. `"hermes"`, `"lunk"`). Fleet agents share one key, so without this they all log as `fleet`; self-labelling makes traffic attributable. Header wins over the body field. Telemetry only — not a trust signal. |
| `augment: "off" \| "auto" \| "force"` (or `X-Augment` header) | Web-search grounding. `off` (**default**) never augments. `auto` runs a search + injects results when the prompt needs current info; `force` always searches. See below. |

### Web-search augment (opt-in)

When a caller opts in with `augment: "auto"` (or `"force"`), the feeder runs the Onboarding-configured search backend (Tavily/DDG/Ollama) and injects the results as a labelled grounding message before routing — so a bare-`auto` question about current events gets a fresh, sourced answer without the caller wiring its own search tool. `"auto"` only searches when the prompt shows a recency/lookup signal; `"force"` always searches. The response carries `X-Augmented: web-search` when results were injected.

**Provenance carve-out.** The default is `"off"` — a request is **never** augmented unless it opts in, so grounded/closed-world callers are never silently web-contaminated. As defence-in-depth, requests labelled `consumer: "open-brain"` are **hard-blocked** from augmentation regardless of the field (extend the blocklist with `AUGMENT_BLOCKED_CONSUMERS`). Augmentation is fully degrade-safe: any missing config / timeout / error just proceeds unaugmented, never blocking the request.

### MCP (Model Context Protocol)

Fleet agents can query the feeder's **live routing state as MCP tools** instead of guessing which model to ask for. Streamable-HTTP MCP endpoint at `POST /mcp` (stateless; read-only — no provider call, nothing mutated). Tools:

- `list_usable_models(task_class?, limit?)` — the models the feeder would actually route to *right now*, best-first, for a task class (coding/math/reasoning/creative/long_context/multi_turn). Only currently-eligible (enabled, keyed, not cooling).
- `explain_routing(task_class?)` — the full routing table in order, with each model's task score, health, latency, and status (`eligible` / `disabled` / `no_key` / `cooling`) plus the reason it's unavailable.

Both wrap the same `explainRouting()` the wiki/analytics use, so a tool result is exactly what the router would do.

### Typed errors

- `422 NO_ELIGIBLE_MODEL` — nothing in the catalogue satisfies the request (capability / cost / context / latency), or no key is configured for one that does. The caller should fall back to its own local/pinned option.
- `429 ALL_RATE_LIMITED` — eligible models exist but every key on every one is currently exhausted/cooling.

### Open WebUI

Settings → Connections → OpenAI API → **+**. Base URL `http://localhost:3001/v1`, API key = your unified key. Feeder's models then appear in the picker; add a model literally named `auto` to let the router choose.

### Agents

Register feeder as a custom OpenAI-compatible provider (base URL + unified key). Have each call-site declare what it needs via `extra_body` (`needs`, `exclude_reasoning`, `latency_ceiling_ms`, …). Because `needs[]` is caller-declared, the router never needs to know anything about your agent — it honours what's asked and refuses cleanly (422) if nothing qualifies, so your agent can fall back to a local model. See the **How To** page for a full example + system prompt.

---

## How routing works

1. **Derive needs** from the request (tools present → `tools`; `response_format` → `json_mode`; `reasoning_effort` → `reasoning_control`) plus any caller-declared `needs[]`.
2. **Hard filter** the catalogue, fresh per attempt: capability match (`json_mode`/`reasoning_control` against the provider dialect; everything else against `source='measured'` capability rows), cost-tier ceiling, context window vs estimated tokens, TPM ceiling, latency ceiling, a configured key, and not circuit-broken.
3. **Rank** the survivors by `health × (quality + latency)`, where latency's weight scales with the declared `latency_ceiling_ms` (tight → speed dominates for chat; loose → quality dominates for batch). Quality comes from web-researched per-task scores; until those exist it falls back to the curated intelligence rank.
4. **Attempt** the top pick; on a retryable error, skip that model+key (cooldown it) and re-filter → next. Exhaustion → the typed errors above. A 429 that clearly signals a **daily/tier quota** is exhausted (not a transient per-minute limit) *parks* the model for `FEEDER_QUOTA_BENCH_MS` (default 6h) so it's skipped until the quota resets, rather than retried every ~90s all day.

The ranking also folds in a small **human-feedback** nudge: thumbs up/down from the Chatbot/Agent UI (`response_feedback` table). Non-image feedback is a general, task-agnostic score adjustment (`FEEDBACK_ROUTING_WEIGHT`, bounded well under the task-quality lift so it nudges, never dominates) over a rolling window (`FEEDBACK_RECENCY_DAYS`, default 30 — so stale votes age out); image feedback instead drives the vision-capability demote (`FEEDBACK_VISION_DEMOTE_THRESHOLD`).

Capability facts are **measured, not assumed** — the probe suite exists because provider spec sheets and docs were wrong often enough to matter live (silent context truncation, unsupported reasoning params, ignored JSON mode, tool-schema rejection). A `declared` (docs/web) fact is a lead for the probe scheduler, never trusted for a hard gate.

---

## Model capabilities & probes

Each model's capabilities are stored per-supplier-instance with a `source`:

- **`measured`** — actually tested on the wire (probes). The only source hard gates trust.
- **`declared`** — sourced from docs/web by research; a lead, not a gate.

Probes (`server/src/services/probes/methods.ts`) test tools (with a realistic nested schema, not a toy), JSON mode (parsed against a schema, not just "no error"), long-context needle recall (scaled to the model's own declared window), and reachability. A full sweep across every keyed model:

```bash
cd server && npx tsx src/scripts/run-full-catalog-sweep.ts [--limit N]
```

Consumers can also report their own measured capability facts via `POST /api/capabilities` (generic — feeder never needs to know what the capability *means*).

---

## Model research (per-model summaries + task scores)

The **Model Wiki** shows a written summary of what each model is good at, plus per-task quality scores — grounded in real web data (arena leaderboards + general search) and written by one of *your own* connected models.

- **Web-search backend** is pluggable (`server/src/services/webSearch.ts`), Ollama's hosted search by default. Add another (Tavily/Brave/SearXNG) by implementing `SearchBackend` and setting `WEB_SEARCH_BACKEND`.
- **Writer model** is `RESEARCH_MODEL` (pick one strong at writing) or auto-picked.
- **Grounded, not fabricated:** the writer uses only the fetched sources and nulls any score it can't support. Scores are `source='benchmark'` (an external claim), never presented as something feeder measured.

Run it:

```bash
cd server && npm run research            # all canonical models
cd server && npm run research -- --limit 10
# or per-model from the UI / API: POST /api/canon/:id/research
```

Re-runs are idempotent — they only fill gaps (a written summary is never overwritten with null). Note: free web-search tiers cap requests per hour, so a full catalogue populate fills in across re-runs.

It is **not** wired to a persistent schedule by default — a standing job that spends provider/search quota on a timer is an operator decision; the mechanism is built and runnable on demand.

---

## Model health & auto-disable

- **Health** (`server/src/services/modelHealth.ts`) is derived on a 5-minute cadence from the request log — passively, no extra probe traffic. It tracks recent median latency, success rate, a circuit-breaker cooldown on fresh 429s/timeouts, and conservative quota-aware benching.
- **No-key grace period:** if a platform loses its last usable key and it isn't replaced within 10 minutes, that platform's models are auto-disabled until a key returns.
- A single `disabled_reason` (`no_key` / `unhealthy` / `manual`) ensures the auto-disable mechanisms and a human's manual toggle never fight each other.

---

## Development

```bash
cd server && npm test          # vitest — full suite
cd server && npm run build     # tsc
cd client && npm run build     # vite
```

Schema changes: edit `server/src/db/schema.ts`, then `npx drizzle-kit generate` + `npx drizzle-kit migrate`.

---

## Credits

Built on [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi). The UI design is a Claude Design handoff implementation.
