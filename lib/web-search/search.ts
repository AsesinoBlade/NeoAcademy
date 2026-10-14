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
  /** Engine chosen in the UI (globe). See webSearch() for the fallback rules. */
  provider?: WebSearchProviderChoice;
  includeAnswer?: boolean;
}

/** Search using the best available provider */
export type WebSearchProviderChoice = 'tavily' | 'brave' | 'searxng' | 'duckduckgo';

/**
 * Search the web.
 *
 * `provider` is the engine chosen with the globe in the UI. The chosen engine
 * is used first; fallbacks only happen when it FAILS (unreachable, HTTP
 * error, rate-limited) — never just because a search found nothing, so an
 * empty SearXNG result does not turn into a DuckDuckGo request.
 *
 *   searxng    → SearXNG, then DuckDuckGo only if SearXNG fails
 *   duckduckgo → DuckDuckGo (HTML results, then Instant Answers)
 *   tavily     → Tavily, then SearXNG / DuckDuckGo if Tavily fails or has no key
 *   brave      → Brave, then SearXNG / DuckDuckGo if Brave fails or has no key
 *
 * With no provider (older callers): SearXNG if SEARXNG_URL is set, otherwise
 * Tavily → Brave → DuckDuckGo, with the same failure-only fallback.
 */
export async function webSearch(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
  const { maxResults = 5 } = opts;
  const provider = opts.provider ?? (process.env.WEB_SEARCH_PROVIDER as WebSearchProviderChoice | undefined);
  // Keys come from the settings DB; if it can't be read, carry on with the
  // keyless providers (SearXNG / DuckDuckGo) rather than failing.
  const noKeys = { tavily: { enabled: false, apiKey: '' }, brave: { enabled: false, apiKey: '' } };
  const config = await import('@/lib/db/config')
    .then((m) => m.getWebSearchConfig())
    .catch((err) => {
      log.warn('Web search settings unavailable, using keyless providers:', err);
      return noKeys;
    });

  const searxngUrl = process.env.SEARXNG_URL?.trim() || (provider === 'searxng' ? 'http://127.0.0.1:8888' : '');

  type Engine = { name: string; run: () => Promise<SearchResult[]> };
  const engines: Record<WebSearchProviderChoice, Engine | null> = {
    tavily:
      config.tavily?.enabled && config.tavily?.apiKey
        ? { name: 'Tavily', run: () => tavilySearch(query, config.tavily.apiKey, maxResults) }
        : null,
    brave:
      config.brave?.enabled && config.brave?.apiKey
        ? { name: 'Brave', run: () => braveSearch(query, config.brave.apiKey, maxResults) }
        : null,
    searxng: searxngUrl ? { name: 'SearXNG', run: () => searxngSearch(searxngUrl, query, maxResults) } : null,
    duckduckgo: { name: 'DuckDuckGo', run: () => duckduckgoHtmlSearch(query, maxResults) },
  };

  const order: WebSearchProviderChoice[] =
    provider === 'searxng'
      ? ['searxng', 'duckduckgo']
      : provider === 'duckduckgo'
        ? ['duckduckgo']
        : provider === 'tavily'
          ? ['tavily', 'searxng', 'duckduckgo']
          : provider === 'brave'
            ? ['brave', 'searxng', 'duckduckgo']
            : searxngUrl
              ? ['searxng', 'duckduckgo']
              : ['tavily', 'brave', 'duckduckgo'];

  for (const id of order) {
    const engine = engines[id];
    if (!engine) continue;
    try {
      const results = await engine.run();
      log.info(`Web search via ${engine.name}: ${results.length} results`);
      // A working engine that found nothing is an answer, not a failure.
      return results;
    } catch (err) {
      log.warn(`${engine.name} search failed${order.indexOf(id) < order.length - 1 ? ', trying the next engine' : ''}:`, err);
    }
  }

  // Last resort for the DuckDuckGo choice: Instant Answers (encyclopedic only).
  if (provider === 'duckduckgo' && !duckduckgoCoolingDown()) {
    try {
      return await duckduckgoSearch(query, maxResults);
    } catch {
      /* fall through */
    }
  }
  return [];
}

// ── DuckDuckGo protection: throttle + cooldown after a block ────────────────

interface DdgState {
  queue: Promise<unknown>;
  lastRequestAt: number;
  cooldownUntil: number;
}
const ddg: DdgState = ((globalThis as typeof globalThis & { __neoacademyDdg?: DdgState }).__neoacademyDdg ??= {
  queue: Promise.resolve(),
  lastRequestAt: 0,
  cooldownUntil: 0,
});
const DDG_MIN_INTERVAL_MS = 3000;
const DDG_COOLDOWN_MS = 15 * 60 * 1000;

function duckduckgoCoolingDown(): boolean {
  return Date.now() < ddg.cooldownUntil;
}

/** One DuckDuckGo request at a time, at most one every 3 s. */
function ddgThrottled<T>(task: () => Promise<T>): Promise<T> {
  const run = ddg.queue.then(async () => {
    if (duckduckgoCoolingDown()) {
      throw new Error(
        `DuckDuckGo is cooling down after a rate-limit block (until ${new Date(ddg.cooldownUntil).toLocaleTimeString()})`,
      );
    }
    const wait = ddg.lastRequestAt + DDG_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    ddg.lastRequestAt = Date.now();
    return task();
  });
  ddg.queue = run.catch(() => undefined);
  return run;
}

function ddgBlocked(reason: string): never {
  ddg.cooldownUntil = Date.now() + DDG_COOLDOWN_MS;
  log.warn(`DuckDuckGo blocked the request (${reason}); not using it for 15 minutes`);
  throw new Error(`DuckDuckGo rate-limited (${reason})`);
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

// ── SearXNG pacing and backoff ─────────────────────────────────────────────
//
// SearXNG forwards every query to upstream engines (Brave, Google, DuckDuckGo,
// ...). Rapid-fire lookups get those engines rate-limited, and SearXNG then
// suspends them (1 h for "too many requests", 24 h for a CAPTCHA). So:
// requests are spaced out, and when SearXNG answers with nothing because its
// engines are suspended, web lookups pause (5 min, doubling to 30 min).

interface SearxState {
  queue: Promise<unknown>;
  lastRequestAt: number;
  degradedUntil: number;
  backoffMs: number;
}
const searx: SearxState = ((globalThis as typeof globalThis & { __neoacademySearx?: SearxState }).__neoacademySearx ??= {
  queue: Promise.resolve(),
  lastRequestAt: 0,
  degradedUntil: 0,
  backoffMs: 0,
});
const SEARX_MIN_INTERVAL_MS = Number.parseInt(process.env.SEARXNG_MIN_INTERVAL_MS || '2500', 10);
const SEARX_BACKOFF_START_MS = 5 * 60 * 1000;
const SEARX_BACKOFF_MAX_MS = 30 * 60 * 1000;

/** True while SearXNG's upstream engines are suspended (see searxngSearch). */
export function searxngDegraded(): boolean {
  return Date.now() < searx.degradedUntil;
}

async function searxngSearch(baseUrl: string, query: string, maxResults: number): Promise<SearchResult[]> {
  if (searxngDegraded()) {
    // Answered, not failed: don't spill over to DuckDuckGo.
    return [];
  }
  return (searx.queue = searx.queue
    .catch(() => undefined)
    .then(async () => {
      const wait = searx.lastRequestAt + SEARX_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      searx.lastRequestAt = Date.now();
      return searxngRequest(baseUrl, query, maxResults);
    })) as Promise<SearchResult[]>;
}

async function searxngRequest(baseUrl: string, query: string, maxResults: number): Promise<SearchResult[]> {
  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}${res.status === 403 ? ' (is "json" in search.formats in settings.yml?)' : ''}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
    unresponsive_engines?: Array<[string, string]>;
  };
  const unresponsive = data.unresponsive_engines ?? [];
  const found = (data.results || []).filter((r) => r.url).length;
  if (unresponsive.length) {
    log.warn(`SearXNG engines not answering: ${unresponsive.map(([name, why]) => `${name} (${why})`).join(', ')}`);
  }
  if (found === 0 && unresponsive.some(([, why]) => /suspended|too many|captcha|access denied/i.test(why))) {
    searx.backoffMs = Math.min(searx.backoffMs ? searx.backoffMs * 2 : SEARX_BACKOFF_START_MS, SEARX_BACKOFF_MAX_MS);
    searx.degradedUntil = Date.now() + searx.backoffMs;
    log.warn(
      `SearXNG's engines are rate-limited; pausing web lookups for ${Math.round(searx.backoffMs / 60000)} min ` +
        '(fact-check continues with local documentation; affected claims are marked unverified).',
    );
  } else if (found > 0) {
    searx.backoffMs = 0;
  }
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
  return ddgThrottled(async () => {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NeoAcademy/1.0',
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 403 || res.status === 429) ddgBlocked(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`DuckDuckGo HTML HTTP ${res.status}`);
  const html = await res.text();
  // A block can also arrive as 200/202 with a bot-check page instead of results.
  if (/anomaly-modal|challenge-form|unusual traffic/i.test(html)) ddgBlocked('bot check page');
  return parseDuckDuckGoHtml(html, maxResults);
  });
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
