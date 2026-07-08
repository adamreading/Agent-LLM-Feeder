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
    // Set true only when services/platformKeyWatch.ts disabled this row
    // because its platform had zero usable keys for 10+ minutes (Adam's
    // directive, 2026-07-08) — distinguishes an auto-disable from a human
    // manually disabling this specific model, so re-enabling on key-return
    // only ever restores what THIS mechanism turned off.
    autoDisabledNoKey: boolean('auto_disabled_no_key').notNull().default(false),
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
