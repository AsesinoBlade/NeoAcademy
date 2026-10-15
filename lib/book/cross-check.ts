/**
 * Independent cross-check for claims nothing else could verify.
 *
 * 1. The questions behind the claims (written by the claim extractor without
 *    revealing the answer) are answered by a separate call that never sees
 *    the book's text.
 * 2. Another call compares each answer with the book's statement:
 *    agree → "cross-checked", disagree → "disputed" (the editor must resolve
 *    it or label it), unsure → stays unverified.
 */
import type { NextRequest } from 'next/server';

import { parseJsonResponse } from '@/lib/generation/json-repair';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import { generateBookText } from './llm';
import type { Evidence } from './references';

const MAX_CROSS_CHECKS = 5;

export async function crossCheckUnverified(req: NextRequest, evidence: Evidence[], context: string): Promise<number> {
  const targets = evidence
    .filter((e) => e.verdict === 'unknown' && !!e.claim.question)
    .slice(0, MAX_CROSS_CHECKS);
  if (targets.length === 0) return 0;

  const ask = buildPrompt(PROMPT_IDS.BOOK_CROSS_CHECK, {
    context,
    questions: targets.map((e, i) => `q${i + 1}. ${e.claim.question}`).join('\n'),
  });
  if (!ask) return 0;
  const answersRaw = await generateBookText(req, ask.system, ask.user, 2500, 'book-cross-check');
  const answers = parseJsonResponse<unknown>(answersRaw);
  const byId = new Map(
    (Array.isArray(answers) ? answers : [])
      .filter((a): a is { id: string; answer: string; confidence?: string } => !!a && typeof (a as { id?: unknown }).id === 'string')
      .map((a) => [a.id, a]),
  );

  const pairs = targets
    .map((e, i) => {
      const a = byId.get(`q${i + 1}`);
      return a ? `q${i + 1}\nSTATEMENT: ${e.claim.statement}\nANSWER (${a.confidence ?? 'unknown'} confidence): ${a.answer}` : '';
    })
    .filter(Boolean);
  if (!pairs.length) return 0;

  const compare = buildPrompt(PROMPT_IDS.BOOK_CROSS_COMPARE, { pairs: pairs.join('\n\n') });
  if (!compare) return 0;
  const verdictsRaw = await generateBookText(req, compare.system, compare.user, 1500, 'book-cross-compare');
  const verdicts = parseJsonResponse<unknown>(verdictsRaw);
  let changed = 0;
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    const item = v as { id?: string; verdict?: string; correction?: string };
    const index = Number(item.id?.replace(/^q/, '')) - 1;
    const e = targets[index];
    const a = byId.get(item.id ?? '');
    if (!e || !a) continue;
    if (item.verdict === 'agree' && a.confidence !== 'low') {
      e.verdict = 'confirmed';
      e.source = 'cross-check';
      e.reference = 'independent expert answer';
      e.excerpt = a.answer;
      changed++;
    } else if (item.verdict === 'disagree' && a.confidence !== 'low') {
      e.verdict = 'disputed';
      e.source = 'cross-check';
      e.reference = 'independent expert answer';
      e.excerpt = `${a.answer}${item.correction ? `\nSuggested correction: ${item.correction}` : ''}`;
      changed++;
    } else {
      e.excerpt = `${e.excerpt ? `${e.excerpt}\n` : ''}Independent answer (${a.confidence ?? 'unknown'} confidence, inconclusive): ${a.answer}`;
    }
  }
  return changed;
}
