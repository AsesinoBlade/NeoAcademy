/**
 * Stage 2: assemble the book's reference library from its approved
 * verification plan (help output, bundled docs, official web docs as text).
 *
 * POST { bookId } → { libraries, notes }   (idempotent)
 */
import { type NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { assembleReferences } from '@/lib/book/auto-references';
import { readBook, writeBook } from '@/lib/book/storage';

const log = createLogger('Book References API');

export const runtime = 'nodejs';
export const maxDuration = 1800;

export async function POST(req: NextRequest) {
  try {
    const { bookId } = (await req.json()) as { bookId: string };
    const book = await readBook(bookId);
    if (!book) return apiError('INVALID_REQUEST', 404, 'Book not found');
    if (!book.verificationPlan?.decision?.approved) return apiSuccess({ libraries: [], notes: ['Verification plan not approved.'], skipped: true });
    if (book.verificationPlan.assembled) return apiSuccess({ ...book.verificationPlan.assembled, skipped: true });

    const assembled = await assembleReferences(book);
    const fresh = (await readBook(bookId)) ?? book;
    if (fresh.verificationPlan && assembled) {
      fresh.verificationPlan.assembled = assembled;
      await writeBook(fresh);
    }
    log.info(
      `Reference library for "${book.title}": ` +
        (assembled?.libraries.map((l) => `${l.tool} (${l.files} files, ${l.source})`).join(', ') || 'nothing assembled'),
    );
    return apiSuccess({ ...(assembled ?? { libraries: [], notes: [] }) });
  } catch (error) {
    log.error('Reference assembly failed:', error);
    return apiError('GENERATION_FAILED', 500, error instanceof Error ? error.message : String(error));
  }
}
