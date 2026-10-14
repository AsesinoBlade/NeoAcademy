/**
 * Premise check for an ebook request, run before the outline is planned.
 *
 * POST /api/generate/book-premises { requirement, researchContext? }
 * → { premises: PremiseFinding[] }
 */
import { type NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { checkPremises } from '@/lib/book/principles';

const log = createLogger('Book Premises API');

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { requirement, researchContext } = (await req.json()) as {
      requirement: string;
      researchContext?: string;
    };
    if (!requirement?.trim()) return apiError('MISSING_REQUIRED_FIELD', 400, 'requirement is required');
    const premises = await checkPremises(req, requirement, researchContext);
    const flagged = premises.filter((p) => p.verdict !== 'supported');
    log.info(
      `Premise check: ${premises.length} premise(s), ${flagged.length} not supported` +
        (flagged.length ? ` — ${flagged.map((p) => `[${p.verdict}] ${p.premise.slice(0, 60)}`).join('; ')}` : ''),
    );
    return apiSuccess({ premises });
  } catch (error) {
    log.error('Premise check failed:', error);
    return apiError('GENERATION_FAILED', 500, error instanceof Error ? error.message : String(error));
  }
}
