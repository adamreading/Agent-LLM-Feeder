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

// Register additional backends here (e.g. Brave, SearXNG). Each just needs to
// implement SearchBackend; selecting it is then WEB_SEARCH_BACKEND=<id>.
const BACKENDS: Record<string, SearchBackend> = {
  ollama: ollamaBackend,
  ddg: ddgBackend,
  tavily: tavilyBackend,
}

export function getSearchBackend(): SearchBackend {
  // Default stays 'ollama' — it's the only keyless backend confirmed reachable
  // from every egress. Set WEB_SEARCH_BACKEND=ddg (unblocked egress) or
  // =tavily (with TAVILY_API_KEY) to move search off Ollama's quota.
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
