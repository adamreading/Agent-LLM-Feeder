// Ollama's hosted web-search API — the same one Hermes uses (confirmed live
// by wsl-claude from Hermes's own config, 2026-07-07). This is the weekly
// research cron's discovery backend, per Adam's direct instruction: use this,
// not a separate search-grounded model.
const API_BASE = 'https://ollama.com/api';

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

function apiKey(): string {
  const key = process.env.OLLAMA_API_KEY;
  if (!key) throw new Error('OLLAMA_API_KEY not set — required for the research cron web search backend.');
  return key;
}

export async function webSearch(query: string, maxResults = 5): Promise<WebSearchResult[]> {
  const res = await fetch(`${API_BASE}/web_search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, max_results: maxResults }),
  });
  if (!res.ok) {
    throw new Error(`Ollama web_search error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  const data = await res.json() as { results: WebSearchResult[] };
  return data.results ?? [];
}

export interface WebFetchResult {
  title: string;
  content: string;
  links?: string[];
}

export async function webFetch(url: string): Promise<WebFetchResult> {
  const res = await fetch(`${API_BASE}/web_fetch`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    throw new Error(`Ollama web_fetch error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  return await res.json() as WebFetchResult;
}
