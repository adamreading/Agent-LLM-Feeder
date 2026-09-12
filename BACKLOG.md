# Feeder backlog

Deferred work, most-valuable first. Items graduate to a commit when picked up.

## 1. Real-usage quality capture at feeder's layer (highest value)

The router's quality prior now comes from external leaderboards (LMArena + Artificial
Analysis, zero-token weekly). The *self-correcting* half — `task_scores`
`source='realtime_quality'`, blended over the prior — is effectively **off**: 9 rows
in two months, newest 2026-08-15, because it depends on a consumer voluntarily reporting
a judged score (`modelPerf.recordRealtimeQuality`).

Feeder is the one choke point that sees every response, so it can grade its own traffic
cheaply without waiting on callers:
- **Free-signal proxies, already logged** (no extra call): empty-output rate, refusal
  rate, error rate, latency, output/input ratio — fold these into a per-(model,task)
  health-adjacent quality signal.
- **Sampled LLM-judge**: grade ~1–5% of real responses with a free model as judge,
  writing `realtime_quality`. Bounded + cached; feeder already has a search cache and
  swarm-budget patterns to copy. Keep it off the hot path (fire-and-forget like
  `logRequest`).

Why it matters: leaderboards rank a model in the abstract; they don't know that *this*
provider's free tier truncates, or that a model that benches well fails feeder's real
prompts. The realtime signal is what makes routing learn from actual outcomes. Blend
weight already exists (`REALTIME_QUALITY_BLEND=0.4`); it just has almost no data.

## 2. Specialist (non-chat) model categories — image / tts / stt / ocr / music

Adam, 2026-09-12: free non-chat models are thrown away today (catalog has, all free, on
keys we already hold: **image_gen 22, tts 11, stt 7, ocr 7, music 6**). A model whose
PRIMARY purpose is image-gen (even if it also chats — Firefly-style) must be reachable
ONLY via a specialist route, **never on a chat call**.

**How it works with feeder's existing architecture** (the foundation is already here):
- `models.kind` is the modality gate; models are now correctly categorized
  (`modelKind.classifyModelKind`, 2026-09-12). The router filters `kind='chat'` and
  scores survivors by a composite (health + quality + latency + coverage).
- **Add per-modality endpoints** — each is a standard OpenAI-compatible shape, so any
  OpenAI client speaks them with no custom work:
  - image → `POST /v1/images/generations`
  - TTS   → `POST /v1/audio/speech`
  - STT   → `POST /v1/audio/transcriptions`
  - OCR   → `POST /v1/ocr` (Mistral shape) or a doc endpoint
  - music → `POST /v1/audio/music` (niche; defer)
  A model band sentinel (`auto`, or `image`/`tts`/…) selects the category, exactly like
  `auto/coding` does for chat.
- **Generalise the router**: `routeRequest({ kind })` instead of hardcoded `'chat'` —
  same scorer, candidate pool filtered to the requested kind. Quality priors: LMArena
  has a **text-to-image arena** (`arena.ai/leaderboard/text-to-image`) → leaderboardSync
  can pull image quality too; TTS/STT have no good free board, so rank by
  health+latency+coverage (self-correcting from real use once #1 lands).
- **Per-(provider, modality) adapters** — the bulk of the work. Each provider's image/
  audio API differs (Cloudflare `/ai/run/@cf/<model>`, Google Gemini generateContent
  with image output, Mistral `/v1/ocr` + `/v1/audio`). A provider implements only the
  modalities it supports (optional methods); only those are eligible — same shape as the
  existing chat provider abstraction.
- **Enable-on-discovery for specialists**: extend catalogSync stage 2c (chat-only today)
  to enable free non-chat models into their kind, so a new image/tts model is routable in
  its category the day it appears.

Categorization is by PRIMARY purpose: one `kind` per model = its main modality; the chat
side of an image-primary model is deliberately NOT exposed (Adam's rule). Firefly-style
"does everything" models get `kind='image_gen'` and answer only `/v1/images/generations`.

**Phasing (recommended): prove ONE modality end-to-end first.** Cleanest candidate is
**image generation via Cloudflare** — 9 free flux/SD models, no card, $0, a clean
`/ai/run` API — plus the LMArena text-to-image priors: one endpoint + one adapter + the
existing router, giving a working `/v1/images/generations` that routes across free image
models. Then repeat the pattern for TTS/STT/OCR. Each modality after the first is mostly
a new adapter, not new architecture.

Structural safety carries over: `$0`/no-card providers can't be charged, and the
free-only gate + `paid_tier` classification apply per-kind exactly as for chat.
