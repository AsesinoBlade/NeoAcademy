/**
 * Web Search API
 *
 * POST /api/web-search
 * Simple JSON request/response using Tavily search.
 */

import { searchWithTavily, formatSearchResultsAsContext } from '@/lib/web-search/tavily';
import { resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';

const log = createLogger('WebSearch');

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { query, apiKey: clientApiKey } = body as {
      query?: string;
      apiKey?: string;
    };

    if (!query || !query.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'query is required');
    }

    const apiKey = resolveWebSearchApiKey(clientApiKey);
    if (!apiKey) {
      // No Tavily key: fall back to the unified client (Brave → SearXNG →
      // DuckDuckGo) instead of failing the whole generation.
      const { webSearch, formatSearchResultsForPrompt } = await import('@/lib/web-search/search');
      const results = await webSearch(query.trim(), { maxResults: 6 });
      return apiSuccess({
        answer: '',
        sources: results.map((r) => ({ title: r.title, url: r.url, content: r.content })),
        context: formatSearchResultsForPrompt(results),
        query: query.trim(),
        responseTime: 0,
      });
    }

    const result = await searchWithTavily({ query: query.trim(), apiKey });
    const context = formatSearchResultsAsContext(result);

    return apiSuccess({
      answer: result.answer,
      sources: result.sources,
      context,
      query: result.query,
      responseTime: result.responseTime,
    });
  } catch (err) {
    log.error('[WebSearch] Error:', err);
    const message = err instanceof Error ? err.message : 'Web search failed';
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
