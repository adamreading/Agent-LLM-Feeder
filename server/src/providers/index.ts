import type { Platform } from '@freellmapi/shared/types.js';
import type { BaseProvider } from './base.js';
import { GoogleProvider } from './google.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { CohereProvider } from './cohere.js';
import { CloudflareProvider } from './cloudflare.js';

const providers = new Map<Platform, BaseProvider>();

function register(provider: BaseProvider) {
  providers.set(provider.platform, provider);
}

// Google - unique Gemini API format
register(new GoogleProvider());

// Groq - OpenAI-compatible. gpt-oss models on Groq accept the flat
// `reasoning_effort` field, BUT a live P2 demo proved it's an intensity
// SCALE, not an on/off toggle: "400: reasoning_effort must be one of low,
// medium, or high" — it rejects our neutral 'none' value outright. Reasoning
// dialect left UNDECLARED (never silently reinterpret 'none' as 'low' —
// that's a real behavior change, not a wire-format translation) pending a
// P3/P4 decision on whether 'none' maps to something at all for this dialect.
register(new OpenAICompatProvider({
  platform: 'groq',
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  dialect: { jsonMode: true },
}));

// Cerebras - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'cerebras',
  name: 'Cerebras',
  baseUrl: 'https://api.cerebras.ai/v1',
  dialect: { jsonMode: true },
}));

// SambaNova - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'sambanova',
  name: 'SambaNova',
  baseUrl: 'https://api.sambanova.ai/v1',
  dialect: { jsonMode: true },
}));

// NVIDIA NIM - OpenAI-compatible. wsl-claude confirmed chat_template_kwargs
// reasoning control live against Hermes's specific configured model
// (2026-07-07) — but a live P2 demo against a DIFFERENT NIM model
// (Mistral Large 3) proved that dialect is NOT universal across NIM's
// catalog: "400: chat_template is not supported for Mistral tokenizers."
// NIM fronts many unrelated model families (Llama/Mistral/DeepSeek/MiniMax),
// each with its own tokenizer/chat-template — reasoning support is a
// per-MODEL fact, not a per-provider one. Left UNDECLARED at the provider
// level pending P3 per-model probes; the chat_template_enable_thinking
// translation code stays available in openai-compat.ts for whichever
// specific NIM model(s) P3 confirms actually support it.
register(new OpenAICompatProvider({
  platform: 'nvidia',
  name: 'NVIDIA NIM',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  dialect: { jsonMode: true },
}));

// Mistral - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'mistral',
  name: 'Mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  dialect: { jsonMode: true },
}));

// OpenRouter - OpenAI-compatible with extra headers. Aggregates many upstream
// models with heterogeneous reasoning AND json_mode support — same failure
// class as NVIDIA NIM (ob-claude review, 2026-07-07): response_format
// support varies by underlying routed model, not by "is OpenRouter
// OpenAI-compatible." Some routed models silently ignore response_format and
// return prose instead of erroring. Dialect left fully UNDECLARED (neither
// jsonMode nor reasoning) pending P3's per-model answer — same treatment as
// Kilo/Pollinations/LLM7.
register(new OpenAICompatProvider({
  platform: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  extraHeaders: {
    'HTTP-Referer': 'http://localhost:3001',
    'X-Title': 'FreeLLMAPI',
  },
}));

// GitHub Models — OpenAI-compatible. Catalog uses `<publisher>/<model>` ids
// (e.g. `openai/gpt-4.1`); the old Azure endpoint rejects that prefix with
// "Unknown model", so route to the current models.github.ai endpoint.
register(new OpenAICompatProvider({
  platform: 'github',
  name: 'GitHub Models',
  baseUrl: 'https://models.github.ai/inference',
  dialect: { jsonMode: true },
}));

// Cohere - OpenAI-compatible via Cohere compatibility endpoint
register(new CohereProvider());

// Cloudflare Workers AI - OpenAI-compatible endpoint (key = "account_id:token")
register(new CloudflareProvider());

// Zhipu (Z.ai / bigmodel.cn) - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'zhipu',
  name: 'Zhipu AI',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  dialect: { jsonMode: true },
}));

// Hugging Face, Moonshot, MiniMax direct integrations were dropped in V4 —
// HF tool-call format issues; Moonshot moved to paid; MiniMax superseded by
// the OpenRouter route (openrouter/minimax/minimax-m2.5:free).

// Ollama Cloud — OpenAI-compatible. Free plan: 1 concurrent model, 5h session
// caps, GPU-time-based quota (not per-token). Many catalog models on the
// /v1/models list are subscription-only — Free returns 403 with an explicit
// "this model requires a subscription" message. Catalog rows are filtered to
// confirmed-Free entries.
//
// Frontier reasoning models (glm-4.7, kimi-k2-thinking, cogito-2.1:671b)
// regularly take 30-90s on Ollama Cloud Free, so the timeout is bumped from
// the default 15s. Ollama returns reasoning in `message.reasoning` (not
// `reasoning_content`) — handled by normalizeChoices.
// Reasoning control is the nested `reasoning:{effort}` shape — wsl-claude
// confirmed live against BOTH of Hermes's actual Ollama models (2026-07-07):
// gemma4:12b (0 chars @0.49s vs 984 baseline) and qwen3.5. Covers Hermes's
// full Ollama surface; other catalog entries here remain unconfirmed.
//
// contextLength: 'ollama_num_ctx' — CONFIRMED REQUIRED, not just suspected:
// ob-claude's review flagged Ollama's OpenAI-compat endpoint silently
// truncating at num_ctx=2048 regardless of the model's real window (caught
// via a wiki article that silently came out wrong, no crash); wsl-claude
// then confirmed from Hermes's own source that this is real — Hermes's
// fix_voice_model_route already resolves num_ctx explicitly for exactly
// this reason (2026-07-07).
register(new OpenAICompatProvider({
  platform: 'ollama',
  name: 'Ollama Cloud',
  baseUrl: 'https://ollama.com/v1',
  timeoutMs: 120000,
  dialect: { jsonMode: true, reasoning: 'nested_reasoning_effort', contextLength: 'ollama_num_ctx' },
}));

// Kilo AI Gateway — OpenAI-compatible aggregator. Anonymous access works
// (200 req/hr per IP) for the few :free routes still active; a Kilo API key
// raises the limit. Most named "free" routes in the docs have transitioned to
// paid ("free period ended") — probe before adding catalog rows. Dialect left
// UNDECLARED: it fronts unknown/rotating upstream models, so "does response_format
// actually work" is exactly the kind of claim P3's probes should confirm
// first — capability-filtered out of json_mode/reasoning requests until then.
register(new OpenAICompatProvider({
  platform: 'kilo',
  name: 'Kilo Gateway',
  baseUrl: 'https://api.kilo.ai/api/gateway/v1',
}));

// Pollinations — OpenAI-compatible, anonymous tier. The chat completions
// endpoint lives at `/openai/v1/chat/completions` (NOT `/v1/...` — the
// `/openai` prefix is mandatory). Public model list returns one anonymous
// model (`openai-fast` = GPT-OSS 20B on OVH, tools=true). Dialect left
// UNDECLARED pending P3 probe verification (same reasoning as Kilo above).
register(new OpenAICompatProvider({
  platform: 'pollinations',
  name: 'Pollinations',
  baseUrl: 'https://text.pollinations.ai/openai/v1',
}));

// LLM7.io — OpenAI-compatible aggregator. 100 req/hr free; anonymous access
// also works for basic models. Wraps a handful of upstream models behind one
// token (GPT-OSS, Llama 3.1 Turbo via Meta, Codestral via Mistral, Ministral,
// GLM-4.6V-Flash). Dialect left UNDECLARED pending P3 probe verification
// (same reasoning as Kilo/Pollinations above).
register(new OpenAICompatProvider({
  platform: 'llm7',
  name: 'LLM7',
  baseUrl: 'https://api.llm7.io/v1',
}));

// Chutes was evaluated for V11 and dropped: probe with a free-tier key
// returned 402 on every model — "Quota exceeded and account balance is
// $0.0, please pay with fiat or send tao". The "free" tier requires a
// non-zero balance, which conflicts with the project's no-card criterion.

export function getProvider(platform: Platform): BaseProvider | undefined {
  return providers.get(platform);
}

export function getAllProviders(): BaseProvider[] {
  return Array.from(providers.values());
}

export function hasProvider(platform: Platform): boolean {
  return providers.has(platform);
}
