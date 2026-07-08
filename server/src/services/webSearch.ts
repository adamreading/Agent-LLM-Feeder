import { webSearch as ollamaSearch, webFetch as ollamaFetch } from './ollamaSearch.js';

// Pluggable web-search layer. The research service talks to THIS, never to a
// specific provider, so the search backend is swappable via .env
// (WEB_SEARCH_BACKEND) without touching research logic. Ollama's hosted
// web-search API is the default (OLLAMA_API_KEY); add another backend by
// implementing SearchBackend and registering it in BACKENDS.

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

// Register additional backends here (e.g. Tavily, Brave, SearXNG). Each just
// needs to implement SearchBackend; selecting it is then WEB_SEARCH_BACKEND=<id>.
const BACKENDS: Record<string, SearchBackend> = {
  ollama: ollamaBackend,
}

export function getSearchBackend(): SearchBackend {
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
