/**
 * POST { bookId, force? } → whole-book consistency pass (lib/book/final-consistency.ts).
 * Idempotent: returns the saved report unless `force`.
 */
import { type NextRequest } from 'next/server';

import { runOncePerKey, peekJson } from '@/lib/book/inflight';
import { runFinalConsistency } from '@/lib/book/final-consistency';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';

const log = createLogger('Book Final Consistency API');

export const runtime = 'nodejs';
export const maxDuration = 900;

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    const { bookId, force } = (await req.json()) as { bookId?: string; force?: boolean };
    if (!bookId) return apiError('MISSING_REQUIRED_FIELD', 400, 'bookId is required');
    const report = await runFinalConsistency(req, bookId, !!force);
    if (!report) return apiError('INVALID_REQUEST', 404, 'Book not found');
    const resolved = report.contradictions.filter((c) => c.applied.length > 0).length;
    return apiSuccess({
      facts: report.facts,
      contradictions: report.contradictions.length,
      resolved,
      open: report.contradictions.length - resolved,
    });
  } catch (error) {
    log.error('Final consistency pass failed:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}

export async function POST(req: NextRequest) {
  const b = await peekJson<{ bookId?: string }>(req);
  return runOncePerKey(b?.bookId ? `consistency ${b.bookId}` : null, () => handlePost(req));
}
