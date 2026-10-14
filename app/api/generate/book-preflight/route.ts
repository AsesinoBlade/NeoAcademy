/**
 * Check that everything book generation needs is installed and configured.
 *
 * POST /api/generate/book-preflight
 *   { stage: 'start' | 'project', bookId?, factCheck, webSearch }
 *   headers: x-image-generation-enabled
 *
 * 'start'   — before the outline: render packages, PDF browser, ComfyUI, web search.
 * 'project' — after the book plan: the tools and toolchain the project's
 *             build commands need (e.g. cmake, make, a C++ compiler, git).
 */
import { type NextRequest } from 'next/server';

import { apiError, apiSuccess } from '@/lib/server/api-response';
import { runPreflight } from '@/lib/book/preflight';
import { readBook } from '@/lib/book/storage';

export const runtime = 'nodejs';
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      stage: 'start' | 'project';
      mode?: 'class' | 'ebook';
      bookId?: string;
      factCheck?: boolean;
      webSearch?: boolean;
    };
    const book = body.stage === 'project' && body.bookId ? await readBook(body.bookId) : null;
    const result = await runPreflight({
      stage: body.stage === 'project' ? 'project' : 'start',
      mode: body.mode === 'class' ? 'class' : 'ebook',
      spec: book?.projectSpec ?? null,
      factCheck: !!body.factCheck,
      webSearch: !!body.webSearch,
      imagesEnabled: req.headers.get('x-image-generation-enabled') === 'true',
      webSearchProvider: req.headers.get('x-web-search-provider') || undefined,
    });
    return apiSuccess({ ...result });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
