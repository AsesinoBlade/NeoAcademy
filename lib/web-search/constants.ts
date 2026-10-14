/**
 * Web Search Provider Constants
 */

import type { WebSearchProviderId, WebSearchProviderConfig } from './types';

/**
 * Web Search Provider Registry
 */
export const WEB_SEARCH_PROVIDERS: Record<WebSearchProviderId, WebSearchProviderConfig> = {
  tavily: {
    id: 'tavily',
    name: 'Tavily',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.tavily.com',
  },
  brave: {
    id: 'brave',
    name: 'Brave Search',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.search.brave.com',
  },
  searxng: {
    // Self-hosted; the server reads SEARXNG_URL from .env.local.
    id: 'searxng',
    name: 'SearXNG (self-hosted)',
    requiresApiKey: false,
    defaultBaseUrl: 'http://127.0.0.1:8888',
  },
  duckduckgo: {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    requiresApiKey: false,
    defaultBaseUrl: 'https://html.duckduckgo.com',
  },
};

/**
 * Get all available web search providers
 */
export function getAllWebSearchProviders(): WebSearchProviderConfig[] {
  return Object.values(WEB_SEARCH_PROVIDERS);
}
