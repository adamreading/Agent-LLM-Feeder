# CLAUDE.md — Agent-LLM-Feeder

Guidance for any Claude working in this repo. The feeder is a live, OpenAI-compatible
routing proxy the whole fleet (Hermes/Lunk, OB, OpenClaw, web chat, crons) depends on —
treat it as production.

## Standing Working Rules (fleet-wide, mandated by Adam 2026-07-13 — no exceptions)

### 1. Verify, don't guess
- NO claim about code / config / runtime stated as fact without reading the actual
  file+line or running the check FIRST. "The code contains X" is NOT "X is live" —
  verify the gate / flag / env / running process that governs it before asserting.
- Docs, CLAUDE.md, and memory are **stale-suspect**, NOT ground truth. Verify against
  LIVE state (the running process, the actual DB row, the real config), not a doc line
  or a memory.
- Anything not directly verified gets LABELLED `unverified` / `assumption`. Never
  launder a guess into a fact.
- If you can't verify, SAY SO and go check — do not fill the gap with a plausible guess.
- Own misses explicitly and immediately when caught.

### 2. No stale docs
- At the end of EVERY medium-size job, update ALL affected docs (this file, README,
  env/config comments, arch/endpoint notes) **as you go**, THEN commit and push
  (this repo HAS a remote — `origin/main`).
- No commit without a doc update when one is appropriate. Stale docs trusted over live
  config are how the fleet gets sent chasing ghosts.

## Repo facts (verify before relying on any of these — they can go stale)

- **DB:** PostgreSQL `feeder` on localhost:5432 (`postgres`). Router/proxy live in
  `server/src`. Client (wiki/vault/analytics UI) in `client/src`.
- **Secrets & search config live in the DB, NOT `.env`** (learned the hard way
  2026-07-14 — cost a spelunk to answer a web-augment question). Only `ENCRYPTION_KEY`
  + `DATABASE_URL` are true `.env` bootstrap secrets. Everything else is in Postgres:
  provider keys + unified caller key (`api_keys` / `settings.unified_api_key`), AND
  the **web-search backend + its API key** (`settings.web_search_backend` plaintext +
  `settings.search_key_<backend>` encrypted, managed from the UI onboarding card).
  `loadSearchConfigIntoEnv()` (`services/searchConfig.ts`) injects the DB search config
  into `process.env` at boot / UI-update / CLI-research start, **overriding** `.env`.
  ⇒ **To check what's LIVE, query the `settings`/`api_keys` tables** — a runtime-injected
  value does NOT appear in `.env` OR `/proc/<pid>/environ` (that's the start-time snapshot).
- **Web-augment mechanism:** per-call `augment` field / `X-Augment` header, values
  **only** `off`/`auto`/`force` (`parseAugmentPolicy` — `on`/`true`/`1` silently → `off`).
  No consumer forces it off except the `open-brain` hard-block (`AUGMENT_BLOCKED_CONSUMERS`);
  default is env `FEEDER_AUGMENT_DEFAULT` (unset→off). Augmented calls are on the
  `X-Augmented` response header AND logged to `requests.augmented` (2026-07-14) so
  `/api/requests` surfaces which calls hit live web. Pre-routing 4xx rejections are also
  logged now — sentinel `platform='rejected'`, `is_probe=true` (so they're excluded from
  real-traffic analytics but visible via `/api/requests` + `?includeProbes=1`); makes a
  restart-dropped stream's downstream 400 observable instead of invisible.
- **Run:** `npm run build:server` then `node dist/index.js` from `server/` (npm start).
  Restart drops in-flight fleet requests — brief, but it's production. After a machine
  **reboot** feeder has no supervisor (Postgres self-recovers via systemd; feeder does
  not) — bring it up via `~/recover-stack.sh` (fleet master) or manually; see
  `RECOVERY.md` (repo root) → full docs at `~/.hermes/RECOVERY.md`.
- **Capability truth lives in two places** — check BOTH: `model_capabilities`
  (measured/observed/declared per-model, the router's hard gate) AND
  `canonical_models` (`vision`/`audio`/`video` declared modality flags from research —
  this is where the wiki's modality badges come from). Querying only one misled a prior
  session into a false "zero vision models" claim.
- **Routing:** `services/router.ts` orders by composite score (task_scores dominant);
  `needs[]` is a hard capability filter; `promptClassifier.ts` turns a bare-`auto`
  prompt into a task_class. Vision uses a relaxed declared→try→confirm gate.
- **Web-search augment** (`services/augment.ts`, Phase 4): opt-in `augment`
  field/`X-Augment` header (off/auto/force). Default OFF (env-overridable via
  `FEEDER_AUGMENT_DEFAULT`). Precedence is load-bearing: the `consumer='open-brain'`
  hard block (OB provenance carve-out) wins over BOTH the field and the env default —
  evaluated first, unconditional. Degrade-safe.
- **Endpoints:** OpenAI-compatible proxy at `/v1` (chat/completions, models); MCP
  server at `/mcp` (`routes/mcp.ts`, Streamable HTTP, stateless, read-only) exposing
  `list_usable_models` / `explain_routing` — both wrap `router.explainRouting()`.
- **Coordination board** (with peers wsl-claude / ob-claude): run
  `node .claude/coordination/coord.js {show|msg|...}` with `COORD_AGENT=feeder-claude`.
