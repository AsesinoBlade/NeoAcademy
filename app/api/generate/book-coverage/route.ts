/**
 * POST { requirement, outline } → does the planned outline cover what the
 * reader asked for? Lists each requirement as covered / partial / missing /
 * violated (e.g. wrong region), with what the outline should change.
 * Runs before writing, on the outline review screen.
 */
import { type NextRequest } from 'next/server';

import { generateBookText } from '@/lib/book/llm';
import { parseSectionSpec } from '@/lib/book/storage';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import type { SceneOutline } from '@/lib/types/generation';

const log = createLogger('Book Coverage API');

export const runtime = 'nodejs';
export const maxDuration = 900;

export interface CoverageItem {
  requirement: string;
  status: 'covered' | 'partial' | 'missing' | 'violated';
  where: string[];
  fix?: string;
}

export async function POST(req: NextRequest) {
  try {
    const { requirement, outline } = (await req.json()) as { requirement?: string; outline?: SceneOutline[] };
    if (!requirement?.trim() || !Array.isArray(outline) || !outline.length) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'requirement and outline are required');
    }
    const text = outline
      .map((ch, ci) =>
        [
          `Chapter ${ci + 1}: ${ch.title}${ch.description ? ` — ${ch.description}` : ''}`,
          ...(ch.keyPoints ?? [])
            .filter((k) => k.trim())
            .map((k, si) => {
              const { title, spec } = parseSectionSpec(k);
              return `  ${ci + 1}.${si + 1} ${title}${spec ? `: ${spec}` : ''}`;
            }),
        ].join('\n'),
      )
      .join('\n');
    const prompt = buildPrompt(PROMPT_IDS.BOOK_COVERAGE, { requirement: requirement.trim(), outline: text });
    if (!prompt) return apiError('INTERNAL_ERROR', 500, 'book-coverage prompt missing');
    const raw = await generateBookText(req, prompt.system, prompt.user, 4000, 'book-coverage');
    const parsed = parseJsonResponse<{ requirements?: unknown[] } | unknown[]>(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed as { requirements?: unknown[] })?.requirements ?? [];
    const items: CoverageItem[] = list
      .map((x) => x as Partial<CoverageItem>)
      .filter((x) => typeof x?.requirement === 'string')
      .map((x) => ({
        requirement: x.requirement!,
        status: (['covered', 'partial', 'missing', 'violated'] as const).includes(x.status as never) ? x.status! : 'partial',
        where: Array.isArray(x.where) ? x.where.map(String) : [],
        fix: typeof x.fix === 'string' && x.fix.trim() ? x.fix.trim() : undefined,
      }));
    const gaps = items.filter((i) => i.status !== 'covered');
    log.info(`Coverage: ${items.length} requirement(s), ${gaps.length} not fully covered`);
    return apiSuccess({ items });
  } catch (error) {
    log.error('Coverage check failed:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
