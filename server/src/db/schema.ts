import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  real,
  timestamp,
  jsonb,
  unique,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Existing tables (migrated from SQLite, same shape — zero behavior change)
// ---------------------------------------------------------------------------

export const models = pgTable(
  'models',
  {
    id: serial('id').primaryKey(),
    platform: text('platform').notNull(),
    modelId: text('model_id').notNull(),
    displayName: text('display_name').notNull(),
    intelligenceRank: integer('intelligence_rank').notNull(),
    speedRank: integer('speed_rank').notNull(),
    sizeLabel: text('size_label').notNull().default(''),
    rpmLimit: integer('rpm_limit'),
    rpdLimit: integer('rpd_limit'),
    tpmLimit: integer('tpm_limit'),
    tpdLimit: integer('tpd_limit'),
    monthlyTokenBudget: text('monthly_token_budget').notNull().default(''),
    contextWindow: integer('context_window'),
    enabled: boolean('enabled').notNull().default(true),
    // WHY this row is disabled when enabled=false, so multiple independent
    // auto-disable mechanisms never fight (the migration-DELETE/INSERT-war
    // failure class, L12). null = not disabled by a tracked mechanism.
    //   'no_key'    — platformKeyWatch: platform had zero usable keys 10+ min
    //   'unhealthy' — modelHealth: sustained 429s / provider failure
    //   'manual'    — a human turned this specific model off in the UI
    // Each mechanism only ever re-enables rows carrying ITS OWN reason, so a
    // returning key never overrides a health-disable and neither ever
    // overrides a human's manual decision (Adam's directive, 2026-07-08).
    // Consolidated from the earlier auto_disabled_no_key boolean once a second
    // reason (health) appeared — a boolean per reason would have collided.
    disabledReason: text('disabled_reason'),
    // P2 two-gate inner enforcement: policy_matrix.cost_tier_ceiling compares
    // against this. All current catalog models are free-tier; paid models
    // (e.g. a future Codex integration) would be seeded with 'paid'.
    costTier: text('cost_tier').notNull().default('free'),
    // Canonical-model grouping (Adam's directive, 2026-07-08): the SAME
    // underlying model is routinely offered by multiple platforms under
    // different id spellings (e.g. gpt-oss-120b exists on cerebras,
    // sambanova, groq, cloudflare, openrouter, ollama). canonicalModelId is
    // null until the matching job (services/modelCanon.ts) resolves it — a
    // supplier-specific row with no canonical link is real catalog data
    // (routable, probeable) but must NOT surface on the model wiki, which
    // reads canonical_models exclusively. Forward reference to a table
    // defined below in this file — safe in drizzle via the lazy callback.
    canonicalModelId: integer('canonical_model_id').references((): any => canonicalModels.id),
    matchStatus: text('match_status').notNull().default('unmatched'), // 'unmatched' | 'auto_matched' | 'manual_matched' | 'confirmed_new'
  },
  (table) => [unique('models_platform_model_id_unique').on(table.platform, table.modelId)]
);

// One row per real underlying model, deduplicated across every platform that
// offers it. The wiki page reads ONLY this table (+ its linked `models`
// instances for the live per-supplier pills) — a model that hasn't completed
// matching (see `models.matchStatus`) has no row here yet and stays invisible
// to the wiki by construction, not by a filter that could be forgotten.
export const canonicalModels = pgTable(
  'canonical_models',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    summary: text('summary'), // strengths/weaknesses wiki paragraph — null until a human or the research cron writes one
    vision: boolean('vision').notNull().default(false),
    video: boolean('video').notNull().default(false),
    audio: boolean('audio').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('canonical_models_slug_unique').on(table.slug)]
);

// A normalized model_id fingerprint (see modelCanon.ts's normalize()) known
// to belong to a canonical model. UNIQUE across the whole table (not scoped
// per canonical model) — that constraint IS the auto-match mechanism: a new
// row's normalized key either matches exactly one existing alias (auto-link)
// or it doesn't exist yet (stays unmatched, queued for the review UI).
export const canonicalModelAliases = pgTable(
  'canonical_model_aliases',
  {
    id: serial('id').primaryKey(),
    canonicalModelId: integer('canonical_model_id')
      .notNull()
      .references(() => canonicalModels.id, { onDelete: 'cascade' }),
    aliasKey: text('alias_key').notNull(),
  },
  (table) => [unique('canonical_model_aliases_alias_key_unique').on(table.aliasKey)]
);

// Per-task-type QUALITY scores, attached to the CANONICAL model (not the
// supplier instance) — quality is a property of the weights, identical
// whichever platform serves them (Adam's directive, 2026-07-08). Distinct
// from model_capabilities: that table records CAPABILITY (can it tool-call /
// do vision / honor ctx — a hard routing GATE, measured on the wire once);
// this records QUALITY (how good at coding / prose / math — a soft SCORE in
// the routing blend). source='benchmark' is the norm here (Adam chose
// benchmark-only quality scoring — lmarena category leaderboards, scraped
// externally, zero provider-quota cost — over running our own paid quality
// probes). taskType is deliberately FREE TEXT, not an enum/FK: the taxonomy
// (see TASK_TYPES in services/taskScores.ts) is expected to track lmarena's
// evolving categories and must stay trivially adjustable without a migration.
export const taskScores = pgTable(
  'task_scores',
  {
    id: serial('id').primaryKey(),
    canonicalModelId: integer('canonical_model_id')
      .notNull()
      .references(() => canonicalModels.id, { onDelete: 'cascade' }),
    taskType: text('task_type').notNull(),
    score: real('score').notNull(), // normalized 0-1 within the task category
    rank: integer('rank'), // raw leaderboard position when the source provides one (null otherwise)
    source: text('source').notNull().default('benchmark'), // 'benchmark' | 'measured' | 'declared'
    evidence: text('evidence'), // leaderboard URL / snapshot note — never a fabricated judgement
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('task_scores_canonical_task_source_unique').on(table.canonicalModelId, table.taskType, table.source)]
);

// External-benchmark naming → canonical model. Same matching pattern as
// canonicalModelAliases but a SEPARATE table on purpose: that one is
// load-bearing for the live supplier auto-match (modelCanon.matchModels), and
// benchmark-name matching (lmarena's model spellings, which differ again from
// both our supplier ids and our canonical slug) must not leak into that
// routing-adjacent path. UNIQUE(aliasKey) so one benchmark name resolves to
// exactly one canonical model; an unmatched benchmark row queues for the same
// human review as an unmatched supplier row rather than guessing.
export const benchmarkAliases = pgTable(
  'benchmark_aliases',
  {
    id: serial('id').primaryKey(),
    canonicalModelId: integer('canonical_model_id')
      .notNull()
      .references(() => canonicalModels.id, { onDelete: 'cascade' }),
    aliasKey: text('alias_key').notNull(),
  },
  (table) => [unique('benchmark_aliases_alias_key_unique').on(table.aliasKey)]
);

// Tracks how long a platform has had ZERO usable keys (deleted, disabled, or
// auto-disabled-after-failures — any cause, checked uniformly). Adam's
// directive (2026-07-08): a platform dark for 10+ minutes should have its
// models auto-disabled rather than stay silently unroutable-but-enabled;
// this row is the clock that measures "10+ minutes," separate from
// api_keys itself since a key row may not exist at all (never added, or
// deleted) as easily as it may exist-but-be-disabled.
export const platformKeyWatch = pgTable('platform_key_watch', {
  platform: text('platform').primaryKey(),
  keysMissingSince: timestamp('keys_missing_since', { withTimezone: true }),
});

// Per-instance live health + latency, DERIVED (recomputed on the health cron
// from the requests log + quota_snapshots — no hot-path writes, no extra probe
// traffic; the daily revival poll is the only active call). This is the
// selection engine's fast-moving input: the flip-window data (wsl, 2026-07-08)
// showed the needs-filter was correct but selection WITHIN the eligible set had
// no latency/health signal, so it kept landing on 9-12s heavy reasoners while
// sub-second eligible models sat idle. Ranking the eligible set by
// recentLatencyMs (fast wins) × healthScore (flaky sinks), plus a
// circuit-breaker cooldown so failover never re-pays a dead provider's ~15s
// timeout, is what makes the pool ship-ably fast. Quality (task_scores) is the
// slow-moving input; this is the fast one.
export const modelHealth = pgTable('model_health', {
  modelDbId: integer('model_db_id').primaryKey().references(() => models.id, { onDelete: 'cascade' }),
  // 0..1 success-health multiplier: 1 = clean, decays toward ~0.2 under recent
  // 429/timeout, recovers as failures age out of the window / a success lands.
  healthScore: real('health_score').notNull().default(1),
  // Recent median latency (ms) over the observation window — the primary
  // speed-ranking signal. null until we've seen real traffic for this model.
  recentLatencyMs: integer('recent_latency_ms'),
  recentSuccessRate: real('recent_success_rate'), // 0..1 over the window; null = no recent data
  consecutive429: integer('consecutive_429').notNull().default(0),
  last429At: timestamp('last_429_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  // Circuit-breaker: skip this instance entirely until this time (set on a
  // fresh timeout/429). Kills the failover-re-hits-a-dead-provider 15s tax.
  cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
  // Quota-aware parking: when a 429 carries daily-quota-exhausted headers,
  // park until the reset rather than retry-decay a window that can't recover.
  quotaExhaustedUntil: timestamp('quota_exhausted_until', { withTimezone: true }),
  status: text('status').notNull().default('healthy'), // 'healthy' | 'penalized' | 'inactive'
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: serial('id').primaryKey(),
  platform: text('platform').notNull(),
  label: text('label').notNull().default(''),
  encryptedKey: text('encrypted_key').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  status: text('status').notNull().default('unknown'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
});

// requests gains is_probe / session_id / task_class per the P1 plan — additive,
// existing columns/behavior unchanged.
export const requests = pgTable('requests', {
  id: serial('id').primaryKey(),
  platform: text('platform').notNull(),
  modelId: text('model_id').notNull(),
  status: text('status').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  latencyMs: integer('latency_ms').notNull().default(0),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  isProbe: boolean('is_probe').notNull().default(false),
  sessionId: text('session_id'),
  taskClass: text('task_class'),
  // Who made the call (added 2026-07-08, wsl's multi-consumer attribution
  // request): the consumer_keys.label of the authenticated caller, or
  // 'local' for a tokenless localhost call, or 'probe' for internal probe
  // traffic. Makes "which consumer routed to this model" answerable from the
  // request log without cross-referencing another system.
  consumer: text('consumer'),
  // The capability needs[] the router actually filtered on for this call —
  // the empirical proof of whether needs attached (e.g. Lunk's
  // tools/long_context/<declared caps>) or the call ran unfiltered. Stored as a
  // comma-joined string; null/empty = no needs filter applied.
  needs: text('needs'),
  // The classifier's REASON label for the chosen task_class — a FIXED, content-
  // free string (e.g. 'math vocabulary', 'arithmetic symbols (no reasoning
  // framing)', 'reasoning/explanation ask', or 'tier-1 (llama3.2:3b)'). Lets us
  // audit WHY a class was picked (and catch false-positives) without ever storing
  // prompt text (wsl's 2026-07-14 privacy-safe observability ask).
  classifyReason: text('classify_reason'),
});

// Human thumbs-up/down on a served response (Agent/Chatbot UI, 2026-07-14).
// Content-free like `requests` — no prompt/response text, just which model was
// rated and the context (task_class, whether an image was attached). Repeated
// down-votes on an image response drive the vision-capability demote (see
// routes/feedback.ts) — a human signal feeding the same observed=false path a
// genuine provider rejection uses.
export const responseFeedback = pgTable('response_feedback', {
  id: serial('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  modelDbId: integer('model_db_id'),          // resolved from platform+model_id; null if unmatched
  platform: text('platform'),
  modelId: text('model_id'),
  taskClass: text('task_class'),
  hadImage: boolean('had_image').notNull().default(false),
  rating: text('rating').notNull(),           // 'up' | 'down'
  consumer: text('consumer'),                 // e.g. 'agent-ui', 'chatbot-ui'
});

export const fallbackConfig = pgTable(
  'fallback_config',
  {
    id: serial('id').primaryKey(),
    modelDbId: integer('model_db_id')
      .notNull()
      .references(() => models.id),
    priority: integer('priority').notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (table) => [unique('fallback_config_model_db_id_unique').on(table.modelDbId)]
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ---------------------------------------------------------------------------
// New tables — P1 foundation for capability honesty (P2), research (P3),
// and the two-gate trust/policy model (P2, L4)
// ---------------------------------------------------------------------------

// Per-model capability + dialect truth. supported/dialect are the correctness
// gate P2 enforces; score/measuredAt/evidence come from research + probes (P3).
export const modelCapabilities = pgTable(
  'model_capabilities',
  {
    id: serial('id').primaryKey(),
    // cascade: the existing idempotent catalog migrations (db/index.ts
    // migrateModelsV2 etc.) routinely DELETE and re-add models as the free-
    // tier catalog drifts — without cascade, any model with capability data
    // becomes permanently undeletable and crashes server startup (hit this
    // live during P3, 2026-07-07: cerebras/gpt-oss-120b had a fresh probe
    // row when V2's unconditional delete tried to remove it).
    modelDbId: integer('model_db_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(), // 'json_mode' | 'tools' | 'vision' | 'reasoning_control' | 'embeddings' | 'long_context' | ...
    supported: boolean('supported').notNull().default(false),
    dialect: text('dialect'), // wire-format variant when supported varies by provider (e.g. reasoning_control dialects)
    score: real('score'), // measured 0-1 score from probe_results, null until probed
    // 'declared' (research cron: web-search-sourced claim) vs 'measured'
    // (probe bank: actually tested on the wire). Measured should always be
    // trusted over declared where both exist for the same capability — a
    // probe result is ground truth, a search result is a claim.
    source: text('source').notNull().default('declared'),
    measuredAt: timestamp('measured_at', { withTimezone: true }),
    evidence: text('evidence'), // doc URL / probe note
    suspect: boolean('suspect').notNull().default(false), // L9: set true on a runtime capability failure, triggers re-probe
  },
  // One declared row AND one measured row can coexist per (model, capability)
  // — the router/consumers prefer 'measured' when present, fall back to
  // 'declared'. Distinct from P1's original (modelDbId, capability)-only
  // constraint, which could only ever hold one fact per capability.
  (table) => [unique('model_capabilities_model_capability_source_unique').on(table.modelDbId, table.capability, table.source)]
);

// Outbound provider accounts (distinct from api_keys, which store the actual
// encrypted secret) — carries the Codex-style subscription/quota shape per
// Adam's correction: quotaModel distinguishes 'metered' (spend risk) from
// 'subscription_window' (fairness risk only).
export const providerAccounts = pgTable('provider_accounts', {
  id: serial('id').primaryKey(),
  platform: text('platform').notNull(),
  label: text('label').notNull().default(''),
  isPaid: boolean('is_paid').notNull().default(false),
  quotaModel: text('quota_model').notNull().default('metered'), // 'metered' | 'subscription_window'
  windowHours: real('window_hours'), // e.g. 5 for a Codex-style rolling window
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Inbound caller keys — the L4 OUTER gate. Distinct from api_keys (outbound,
// to providers). One row per consumer class (fleet vs external/webui); P1
// migrates today's single settings.unified_api_key into a 'fleet' row here,
// full enforcement lands in P2.
export const consumerKeys = pgTable('consumer_keys', {
  id: serial('id').primaryKey(),
  label: text('label').notNull(), // e.g. 'fleet', 'external-webui'
  keyHash: text('key_hash').notNull().unique(), // hash of the bearer token, never plaintext
  trustTier: text('trust_tier').notNull().default('external'), // 'fleet' | 'external'
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

// Live quota truth, column-owned by header-harvest (L6) — the research cron
// (P3) never writes quotaRemaining/resetAt/observedAt, only capability rows.
export const quotaSnapshots = pgTable(
  'quota_snapshots',
  {
    id: serial('id').primaryKey(),
    platform: text('platform').notNull(),
    modelId: text('model_id'),
    apiKeyId: integer('api_key_id').references(() => apiKeys.id, { onDelete: 'cascade' }), // same cascade reasoning as model_capabilities above
    quotaRemaining: real('quota_remaining'),
    quotaLimit: real('quota_limit'),
    resetAt: timestamp('reset_at', { withTimezone: true }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(), // L7: age-out gate on load
  },
  (table) => [
    unique('quota_snapshots_platform_model_key_unique').on(table.platform, table.modelId, table.apiKeyId),
  ]
);

// Versioned scoring questions AS DATA (not code) — the probe bank the research
// cron (P3) runs against models to produce measured capability scores.
export const probeBank = pgTable('probe_bank', {
  id: serial('id').primaryKey(),
  version: integer('version').notNull(),
  capability: text('capability').notNull(),
  prompt: jsonb('prompt').notNull(), // the probe's messages[] / request shape
  expectedShape: jsonb('expected_shape'), // what a pass looks like
  isPaidProbe: boolean('is_paid_probe').notNull().default(false), // budget-capped per L2/P3
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Probe run results — is_probe traffic is excluded from quality/latency
// scoring that routing reads but DOES still count toward quota (L2 split).
// leaseId supports idempotent/crash-safe probe runs (never double-charge a
// paid probe, per Open Engine's queue pattern).
export const probeResults = pgTable('probe_results', {
  id: serial('id').primaryKey(),
  probeId: integer('probe_id')
    .notNull()
    .references(() => probeBank.id, { onDelete: 'cascade' }),
  modelDbId: integer('model_db_id')
    .notNull()
    .references(() => models.id, { onDelete: 'cascade' }), // same cascade reasoning as model_capabilities above
  passed: boolean('passed').notNull(),
  latencyMs: integer('latency_ms'),
  costEstimate: real('cost_estimate'),
  rawResponse: text('raw_response'),
  leaseId: text('lease_id'),
  measuredAt: timestamp('measured_at', { withTimezone: true }).notNull().defaultNow(),
});

// (task_class × user_pref) -> ceilings. hardCap is the L4 INNER gate: caps
// cost_tier regardless of a claimed quality_floor, independent of the outer
// per-key trust gate above.
export const policyMatrix = pgTable(
  'policy_matrix',
  {
    id: serial('id').primaryKey(),
    taskClass: text('task_class').notNull(),
    userPref: text('user_pref').notNull(), // 'intelligence' | 'budget' | 'speed'
    costTierCeiling: text('cost_tier_ceiling').notNull(), // 'free' | 'paid'
    qualityFloor: text('quality_floor'),
    latencyCeilingMs: integer('latency_ceiling_ms'),
    maxAttempts: integer('max_attempts').notNull().default(5),
    hardCap: boolean('hard_cap').notNull().default(false),
  },
  (table) => [unique('policy_matrix_task_class_user_pref_unique').on(table.taskClass, table.userPref)]
);
