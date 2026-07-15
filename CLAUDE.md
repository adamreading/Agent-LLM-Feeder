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
- **Swarm per-run spend cap** (`services/swarmBudget.ts`, RINGER, 2026-07-15): a
  swarm run's cumulative `(consumer, run_id)` tokens can be HARD-CAPPED. Run id
  arrives on the `X-Run-Id` header (baked literally per-invocation by ringer via
  `OPENCODE_CONFIG` — survives OpenCode like `X-Consumer`, unlike `X-Session-Id`
  which OpenCode clobbers) → read + logged to `requests.run_id`. The dispatch layer
  declares a ceiling once via `POST /api/swarm/budget {run_id, max_tokens}`
  (localhost-only, **set-once/lower-only** so it can't be uncapped mid-run); the
  proxy then refuses over-budget calls PRE-ROUTE with a **terminal** `429`
  (`error.code='run_budget_exceeded'` — ringer STOPS the run, doesn't fail over,
  distinct from retryable `ALL_RATE_LIMITED`). **Opt-in + degrade-safe/fail-open:**
  a run with no declared budget (or one lost to a restart) is unlimited — the
  enforcer only ever ADDS a stop, never a false denial. Bounded-overshoot (tokens
  book on completion; N in-flight calls can overshoot by one wave) — a backstop,
  not a to-the-token meter; cap `--max-parallel` for tighter. In-mem counter seeded
  from the `requests` log on declare (`session_id` = per-attempt view is unchanged).
- **Swarm zero-progress circuit-breaker** (`services/swarmProgress.ts`, 2026-07-15):
  a BACKSTOP for degenerate agent loops. Root cause it kills (verified in the log):
  a weak/free worker returns EMPTY completions, the OpenCode loop never converges,
  and with NO step cap it resends the same ~21k context hundreds of times — one
  observed session ran 252 rounds / 251 zero-output = **6.16M tokens of pure spin**.
  Feeder is the only choke point that sees every call, so it detects the loop: a
  round is "no-progress" when `output<=0 AND input grew < FEEDER_SWARM_NOPROGRESS_INPUT_DELTA`
  (256); after `FEEDER_SWARM_NOPROGRESS_LIMIT` (15; 0=off) consecutive such rounds
  the session is refused PRE-ROUTE with a terminal `429 error.code='no_progress_loop'`
  (ringer STOPS the session, no retry). Swarm-consumers only, keyed on `session_id`
  (one OpenCode loop), fail-open. Kills a spin at ~round 16 vs 252. The REAL fix is
  an OpenCode step/turn cap (ringer's lane, flagged) — this is the safety net.
  `/api/requests` now projects + filters `run_id` (was logged but not surfaced).
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
- **Key health / self-healing** (`services/health.ts`, 5-min cron): a key that returns
  401/403 gets `status='invalid'` and is auto-disabled after 3 consecutive failures.
  `reviveRecoverableKeys` (added 2026-07-15) re-validates `enabled=false AND
  status='invalid'` keys on a 15-min backoff and **auto-re-enables** any that pass again
  — so a TRANSIENT cause (VPN egress block, brief network fault; NordVPN made a good
  groq key look invalid 2026-07-15) self-heals instead of staying stuck. Only
  `invalid` rows are touched, so a human-disabled *healthy* key is left off.
  `platformKeyWatch` then revives that platform's `no_key`-disabled models next cycle.
- **Web-search augment** (`services/augment.ts`, Phase 4): opt-in `augment`
  field/`X-Augment` header (off/auto/force). Default OFF (env-overridable via
  `FEEDER_AUGMENT_DEFAULT`). Precedence is load-bearing: the `consumer='open-brain'`
  hard block (OB provenance carve-out) wins over BOTH the field and the env default —
  evaluated first, unconditional. Degrade-safe.
- **Endpoints:** OpenAI-compatible proxy at `/v1` (chat/completions, models); MCP
  server at `/mcp` (`routes/mcp.ts`, Streamable HTTP, stateless, read-only) exposing
  `list_usable_models` / `explain_routing` — both wrap `router.explainRouting()`.
  Swarm support (`routes/swarm.ts`): `GET /api/swarm/capacity` (free provider lanes),
  `POST /api/swarm/budget` (declare a run's token ceiling, localhost-only) +
  `GET /api/swarm/budget` (read live spend). Per-request telemetry: `GET /api/requests`.
- **Coordination board** (with peers wsl-claude / ringer-claude / ob-claude/windows):
  the board script lives in the Open Brain project, NOT this repo — run
  `node "/mnt/c/Users/<your-windows-user>/projects/Open Brain/.claude/coordination/coord.js" {show|msg|...}`
  with `COORD_AGENT=feeder-claude`. (The `.claude/coordination/` path relative to this
  repo does NOT exist — verified 2026-07-15. The SessionStart/UserPromptSubmit hooks in
  `~/.claude/settings.json` already invoke `coord.js show --compact` from that absolute
  path, which is how the board lands in context each turn.) Backtick trap: never inline a
  backticked shell fragment in a `msg` argument — it triggers command substitution; write
  the message to a scratchpad file and `msg "$(cat file)"`.
