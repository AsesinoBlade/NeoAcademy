/**
 * Meaning check for documentation-confirmed claims.
 *
 * The documentation lookup proves a NAME exists (`ctest -D`), not that the
 * book describes it correctly ("-D VSDebug=1 debugs tests in Visual Studio").
 * Each confirmed claim is compared with its documentation excerpt; a
 * contradiction makes it "disputed" (wrong per the documentation), so the
 * editor corrects it.
 */
import type { NextRequest } from 'next/server';

import { parseJsonResponse } from '@/lib/generation/json-repair';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import { generateBookText } from './llm';
import type { Evidence } from './references';

const MAX_DOC_CHECKS = 10;

export async function checkAgainstDocumentation(req: NextRequest, evidence: Evidence[]): Promise<number> {
  const targets = evidence
    .filter(
      (e) =>
        e.verdict === 'confirmed' &&
        (e.source === 'local-docs' || e.source === 'web') &&
        e.claim.kind !== 'fact' &&
        e.excerpt.trim().length > 40 &&
        !/defined in this book's project/.test(e.reference),
    )
    .slice(0, MAX_DOC_CHECKS);
  if (!targets.length) return 0;
  const prompts = buildPrompt(PROMPT_IDS.BOOK_DOC_CHECK, {
    items: targets
      .map((e, i) => `d${i + 1}\nSTATEMENT: ${e.claim.statement}\nNAME: ${e.claim.identifier}${e.claim.tool ? ` (${e.claim.tool})` : ''}\nEXCERPT (${e.reference}):\n${e.excerpt.slice(0, 1500)}`)
      .join('\n\n'),
  });
  if (!prompts) return 0;
  const parsed = parseJsonResponse<unknown>(await generateBookText(req, prompts.system, prompts.user, 2000, 'book-doc-check'));
  let contradicted = 0;
  for (const item of Array.isArray(parsed) ? parsed : []) {
    const { id, verdict, documentation_says } = (item ?? {}) as { id?: string; verdict?: string; documentation_says?: string };
    const e = targets[Number(String(id).replace(/^d/, '')) - 1];
    if (!e || verdict !== 'contradicts') continue;
    e.verdict = 'disputed';
    e.reference = `${e.reference} (the name exists, but the documentation contradicts what the book says about it)`;
    e.excerpt = `${documentation_says ? `Documentation: ${documentation_says}\n` : ''}${e.excerpt}`;
    contradicted++;
  }
  return contradicted;
}
