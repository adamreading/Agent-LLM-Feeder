import { webSearch as ollamaSearch, webFetch as ollamaFetch } from './ollamaSearch.js';
import { ddgWebSearch } from './ddgSearch.js';

// Pluggable web-search layer. The research service talks to THIS, never to a
// specific provider, so the search backend is swappable via .env
// (WEB_SEARCH_BACKEND) without touching research logic. Add a backend by
// implementing SearchBackend and registering it in BACKENDS.
//
// Backends (2026-07-08):
//  - ollama : hosted web_search + web_fetch (OLLAMA_API_KEY). Reliable but the
//             free tier has hard hourly + weekly caps.
//  - ddg    : DuckDuckGo via duck-duck-scrape for SEARCH, delegates FETCH to
//             Ollama (Adam's "DDG for search, save Ollama for fetches"). Free,
//             no key — BUT DDG IP-blocks sustained scraper traffic ("anomaly"),
//             so a datacenter/WSL egress may be blocked outright. Good when the
//             egress isn't flagged; not reliable as a heavy primary from a
//             blocked IP.
//  - tavily : keyed search API built for LLM research (TAVILY_API_KEY, free
//             tier ~1k/mo). Not IP-scraping, so no anomaly blocking — the
//             reliable primary when a key is available. Returns content inline,
//             so it needs no separate fetch.

export interface SearchResult { title: string; url: string; content: string }
export interface FetchResult { title: string; content: string }

export interface SearchBackend {
  readonly id: string
  /** True when this backend has the config/keys it needs to run. */
  isConfigured(): boolean
  search(query: string, maxResults?: number): Promise<SearchResult[]>
  fetch(url: string): Promise<FetchResult>
}

const ollamaBackend: SearchBackend = {
  id: 'ollama',
  isConfigured: () => !!process.env.OLLAMA_API_KEY,
  search: (q, max = 5) => ollamaSearch(q, max),
  fetch: async (url) => {
    const r = await ollamaFetch(url)
    return { title: r.title, content: r.content }
  },
}

// DDG search + Ollama fetch. Search needs no key; fetch delegates to Ollama
// (best-effort — research degrades to snippet-only if Ollama fetch is
// unavailable), which is exactly "use DDG for search, save Ollama for fetches."
const ddgBackend: SearchBackend = {
  id: 'ddg',
  // Search is keyless; treat as configured whenever selected. (Fetch prefers
  // Ollama but is optional, so a missing OLLAMA_API_KEY doesn't disable it.)
  isConfigured: () => true,
  search: (q, max = 6) => ddgWebSearch(q, max),
  fetch: async (url) => {
    const r = await ollamaFetch(url)
    return { title: r.title, content: r.content }
  },
}

interface TavilyResult { title?: string; url?: string; content?: string; raw_content?: string }
const tavilyBackend: SearchBackend = {
  id: 'tavily',
  isConfigured: () => !!process.env.TAVILY_API_KEY,
  search: async (q, max = 6) => {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: q,
        max_results: max,
        search_depth: 'basic',
      }),
    })
    if (!res.ok) throw new Error(`Tavily search error ${res.status}: ${await res.text().catch(() => res.statusText)}`)
    const data = await res.json() as { results?: TavilyResult[] }
    return (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: (r.content ?? '').trim(),
    })).filter((r) => r.url && r.title)
  },
  // Tavily returns content inline in search, so a follow-up fetch is rarely
  // needed; use its extract endpoint when one is requested anyway.
  fetch: async (url) => {
    const res = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, urls: [url] }),
    })
    if (!res.ok) throw new Error(`Tavily extract error ${res.status}`)
    const data = await res.json() as { results?: { raw_content?: string }[] }
    return { title: url, content: (data.results?.[0]?.raw_content ?? '').slice(0, 8000) }
  },
}

// Brave Search API — independent index, keyed via X-Subscription-Token. Basic
// tier returns snippet-level content (description); page fetch delegates to
// Ollama (best-effort) like DDG.
const braveBackend: SearchBackend = {
  id: 'brave',
  isConfigured: () => !!process.env.BRAVE_SEARCH_API_KEY,
  search: async (q, max = 6) => {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${max}`
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY ?? '' },
    })
    if (!res.ok) throw new Error(`Brave search error ${res.status}: ${await res.text().catch(() => res.statusText)}`)
    const data = await res.json() as { web?: { results?: { title?: string; url?: string; description?: string }[] } }
    return (data.web?.results ?? []).map((r) => ({
      title: r.title ?? '', url: r.url ?? '', content: (r.description ?? '').trim(),
    })).filter((r) => r.url && r.title)
  },
  fetch: async (url) => {
    const r = await ollamaFetch(url)
    return { title: r.title, content: r.content }
  },
}

// Serper.dev — Google SERP results as JSON, keyed via X-API-KEY. Snippet-level
// content; page fetch delegates to Ollama (best-effort).
const serperBackend: SearchBackend = {
  id: 'serper',
  isConfigured: () => !!process.env.SERPER_API_KEY,
  search: async (q, max = 6) => {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, num: max }),
    })
    if (!res.ok) throw new Error(`Serper search error ${res.status}: ${await res.text().catch(() => res.statusText)}`)
    const data = await res.json() as { organic?: { title?: string; link?: string; snippet?: string }[] }
    return (data.organic ?? []).map((r) => ({
      title: r.title ?? '', url: r.link ?? '', content: (r.snippet ?? '').trim(),
    })).filter((r) => r.url && r.title)
  },
  fetch: async (url) => {
    const r = await ollamaFetch(url)
    return { title: r.title, content: r.content }
  },
}

// Exa — neural/semantic search built for AI, keyed via x-api-key. Returns page
// text inline (contents.text), so search alone is content-rich; fetch uses Exa's
// own /contents endpoint.
const exaBackend: SearchBackend = {
  id: 'exa',
  isConfigured: () => !!process.env.EXA_API_KEY,
  search: async (q, max = 6) => {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': process.env.EXA_API_KEY ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, numResults: max, contents: { text: { maxCharacters: 2000 } } }),
    })
    if (!res.ok) throw new Error(`Exa search error ${res.status}: ${await res.text().catch(() => res.statusText)}`)
    const data = await res.json() as { results?: { title?: string; url?: string; text?: string }[] }
    return (data.results ?? []).map((r) => ({
      title: r.title ?? '', url: r.url ?? '', content: (r.text ?? '').trim(),
    })).filter((r) => r.url && r.title)
  },
  fetch: async (url) => {
    const res = await fetch('https://api.exa.ai/contents', {
      method: 'POST',
      headers: { 'x-api-key': process.env.EXA_API_KEY ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [url], text: { maxCharacters: 8000 } }),
    })
    if (!res.ok) throw new Error(`Exa contents error ${res.status}`)
    const data = await res.json() as { results?: { title?: string; text?: string }[] }
    return { title: data.results?.[0]?.title ?? url, content: (data.results?.[0]?.text ?? '').slice(0, 8000) }
  },
}

// SerpApi (serpapi.com) — real Google SERP as JSON, keyed via the api_key query
// param. DISTINCT from Serper. Snippet-level content; page fetch delegates to Ollama.
const serpapiBackend: SearchBackend = {
  id: 'serpapi',
  isConfigured: () => !!process.env.SERPAPI_API_KEY,
  search: async (q, max = 6) => {
    const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=${max}&api_key=${encodeURIComponent(process.env.SERPAPI_API_KEY ?? '')}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`SerpApi search error ${res.status}: ${await res.text().catch(() => res.statusText)}`)
    const data = await res.json() as { organic_results?: { title?: string; link?: string; snippet?: string }[] }
    return (data.organic_results ?? []).map((r) => ({
      title: r.title ?? '', url: r.link ?? '', content: (r.snippet ?? '').trim(),
    })).filter((r) => r.url && r.title)
  },
  fetch: async (url) => {
    const r = await ollamaFetch(url)
    return { title: r.title, content: r.content }
  },
}

// You.com — PAID, LLM-ready web+news search (ydc-index.io), keyed via X-API-Key.
// The paid last-resort backend: searchPool.ts only calls it when every free engine is
// exhausted, gated by per-job ($5) + global spend caps. Response is
// { results: { web: [{title, url, snippets[], description}], news: [...] } }; page
// fetch uses livecrawl-style content when present, else delegates to Ollama.
interface YouWebResult { title?: string; url?: string; snippets?: string[]; description?: string }
const youBackend: SearchBackend = {
  id: 'you',
  isConfigured: () => !!process.env.YOU_API_KEY,
  search: async (q, max = 6) => {
    const url = `https://ydc-index.io/v1/search?query=${encodeURIComponent(q)}&count=${max}`
    const res = await fetch(url, { headers: { 'X-API-Key': process.env.YOU_API_KEY ?? '' } })
    if (!res.ok) throw new Error(`You.com search error ${res.status}: ${await res.text().catch(() => res.statusText)}`)
    const data = await res.json() as { results?: { web?: YouWebResult[] } }
    return (data.results?.web ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: ((r.snippets && r.snippets.length ? r.snippets.join(' ') : r.description) ?? '').trim(),
    })).filter((r) => r.url && r.title)
  },
  fetch: async (url) => {
    const r = await ollamaFetch(url)
    return { title: r.title, content: r.content }
  },
}

// Register additional backends here. Each just needs to implement SearchBackend
// and be listed in searchConfig.ts SEARCH_PROVIDER_CATALOG under the same id;
// selecting it is then WEB_SEARCH_BACKEND=<id>.
const BACKENDS: Record<string, SearchBackend> = {
  ollama: ollamaBackend,
  ddg: ddgBackend,
  tavily: tavilyBackend,
  brave: braveBackend,
  serper: serperBackend,
  exa: exaBackend,
  serpapi: serpapiBackend,
  you: youBackend,
}

/** Look up a backend by id (for targeted verify / diagnostics). */
export function getBackendById(id: string): SearchBackend | undefined {
  return BACKENDS[id.toLowerCase()]
}

export function getSearchBackend(): SearchBackend {
  // ddg is the only KEYLESS backend; every other provider needs its key present
  // (isConfigured gates that). The active backend is normally set in the DB and
  // bridged to WEB_SEARCH_BACKEND at boot/UI-update; 'ollama' is the .env-less
  // fallback for legacy configs.
  const id = (process.env.WEB_SEARCH_BACKEND || 'ollama').toLowerCase()
  const backend = BACKENDS[id]
  if (!backend) {
    throw new Error(`Unknown WEB_SEARCH_BACKEND '${id}'. Available: ${Object.keys(BACKENDS).join(', ')}.`)
  }
  return backend
}

export function searchConfigured(): boolean {
  try { return getSearchBackend().isConfigured() } catch { return false }
}
