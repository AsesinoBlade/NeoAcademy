/**
 * Unified web search client.
 * Tries providers in order: Tavily → Brave → SearXNG (self-hosted, if
 * SEARXNG_URL is set) → DuckDuckGo HTML results (free, no key).
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('WebSearch');

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface SearchOptions {
  maxResults?: number;
  includeAnswer?: boolean;
}

/** Search using the best available provider */
export async function webSearch(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
  const { maxResults = 5 } = opts;
  // Keys come from the settings DB; if it can't be read, carry on with the
  // keyless providers (SearXNG / DuckDuckGo) rather than failing.
  const noKeys = { tavily: { enabled: false, apiKey: '' }, brave: { enabled: false, apiKey: '' } };
  const config = await import('@/lib/db/config')
    .then((m) => m.getWebSearchConfig())
    .catch((err) => {
      log.warn('Web search settings unavailable, using keyless providers:', err);
      return noKeys;
    });

  // 1. Try Tavily
  if (config.tavily.enabled && config.tavily.apiKey) {
    try {
      const results = await tavilySearch(query, config.tavily.apiKey, maxResults);
      if (results.length > 0) {
        log.info(`Web search via Tavily: ${results.length} results`);
        return results;
      }
    } catch (err) {
      log.warn('Tavily search failed:', err);
    }
  }

  // 2. Try Brave
  if (config.brave.enabled && config.brave.apiKey) {
    try {
      const results = await braveSearch(query, config.brave.apiKey, maxResults);
      if (results.length > 0) {
        log.info(`Web search via Brave: ${results.length} results`);
        return results;
      }
    } catch (err) {
      log.warn('Brave search failed:', err);
    }
  }

  // 3. SearXNG — self-hosted metasearch (e.g. docker run -p 8888:8080 searxng/searxng)
  //    with the JSON format enabled in its settings.yml.
  const searxngUrl = process.env.SEARXNG_URL?.trim();
  if (searxngUrl) {
    try {
      const results = await searxngSearch(searxngUrl, query, maxResults);
      if (results.length > 0) {
        log.info(`Web search via SearXNG: ${results.length} results`);
        return results;
      }
    } catch (err) {
      log.warn('SearXNG search failed:', err);
    }
  }

  // 4. DuckDuckGo HTML results (real web results, no key needed)
  try {
    const results = await duckduckgoHtmlSearch(query, maxResults);
    if (results.length > 0) {
      log.info(`Web search via DuckDuckGo: ${results.length} results`);
      return results;
    }
  } catch (err) {
    log.warn('DuckDuckGo HTML search failed:', err);
  }

  // 5. DuckDuckGo Instant Answers (encyclopedic summaries only)
  try {
    const results = await duckduckgoSearch(query, maxResults);
    log.info(`Web search via DuckDuckGo: ${results.length} results`);
    return results;
  } catch (err) {
    log.warn('DuckDuckGo search failed:', err);
  }

  return [];
}

async function tavilySearch(
  query: string,
  apiKey: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: maxResults,
      include_raw_content: false,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = (await res.json()) as {
    results: { title: string; url: string; content: string; score: number }[];
  };

  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score,
  }));
}

async function braveSearch(
  query: string,
  apiKey: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: { title: string; url: string; description: string }[] };
  };

  return (data.web?.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.description || '',
  }));
}

async function searxngSearch(baseUrl: string, query: string, maxResults: number): Promise<SearchResult[]> {
  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status} (is the json format enabled?)`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results || [])
    .filter((r) => r.url)
    .slice(0, maxResults)
    .map((r) => ({ title: r.title || r.url!, url: r.url!, content: r.content || '' }));
}

const decodeEntities = (text: string) =>
  text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();

/** Parse DuckDuckGo's HTML results page (html.duckduckgo.com). Exported for tests. */
export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    let href = link[1].replace(/&amp;/g, '&');
    const redirect = href.match(/[?&]uddg=([^&]+)/);
    if (redirect) href = decodeURIComponent(redirect[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue; // skip ads
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
    results.push({ title: decodeEntities(link[2]), url: href, content: snippet ? decodeEntities(snippet[1]) : '' });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function duckduckgoHtmlSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NeoAcademy/1.0',
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTML HTTP ${res.status}`);
  return parseDuckDuckGoHtml(await res.text(), maxResults);
}

async function duckduckgoSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  // DuckDuckGo Instant Answers API (free, no key)
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_redirect', '1');
  url.searchParams.set('no_html', '1');

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);

  const data = (await res.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    AbstractSource?: string;
    RelatedTopics?: { Text?: string; FirstURL?: string }[];
  };

  const results: SearchResult[] = [];

  if (data.AbstractText) {
    results.push({
      title: data.AbstractSource || query,
      url: data.AbstractURL || '',
      content: data.AbstractText,
    });
  }

  for (const topic of (data.RelatedTopics || []).slice(0, maxResults - 1)) {
    if (topic.Text && topic.FirstURL) {
      results.push({ title: topic.Text.slice(0, 100), url: topic.FirstURL, content: topic.Text });
    }
  }

  return results.slice(0, maxResults);
}

/** Format search results for inclusion in a generation prompt */
export function formatSearchResultsForPrompt(results: SearchResult[]): string {
  if (results.length === 0) return '';

  const formatted = results
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`)
    .join('\n\n');

  return `--- Current web context ---\n${formatted}\n--- End web context ---`;
}
