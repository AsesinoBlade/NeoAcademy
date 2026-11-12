/**
 * Independent cross-check for claims nothing else could verify.
 *
 * 1. The questions behind the claims (self-contained, written by the claim
 *    extractor without revealing the answer) are answered by a separate call
 *    that never sees the book's text.
 * 2. Another call compares each answer with the book's statement.
 * 3. Disagreements go to a judge, because the independent answer comes from a
 *    language model too and can be the wrong one:
 *      - judge says the book is wrong (high confidence) → "disputed": the
 *        editor corrects it;
 *      - judge says the book is right → "confirmed" (cross-checked);
 *      - anything else → stays unverified, marked as contested; the editor
 *        must NOT change the text because of it.
 */
import type { NextRequest } from 'next/server';

import { parseJsonResponse } from '@/lib/generation/json-repair';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import { generateBookText } from './llm';
import type { Evidence } from './references';

const MAX_CROSS_CHECKS = 5;

type Answer = { id: string; answer: string; confidence?: string };

function byIdList<T extends { id?: unknown }>(raw: unknown): Map<string, T> {
  return new Map(
    (Array.isArray(raw) ? raw : [])
      .filter((a): a is T => !!a && typeof (a as { id?: unknown }).id === 'string')
      .map((a) => [String(a.id), a]),
  );
}

export async function crossCheckUnverified(req: NextRequest, evidence: Evidence[], context: string): Promise<number> {
  const targets = evidence.filter((e) => e.verdict === 'unknown' && !!e.claim.question?.trim()).slice(0, MAX_CROSS_CHECKS);
  if (targets.length === 0) return 0;

  // 1. Independent answers (no access to the book).
  const ask = buildPrompt(PROMPT_IDS.BOOK_CROSS_CHECK, {
    context,
    questions: targets.map((e, i) => `q${i + 1}. ${e.claim.question}`).join('\n'),
  });
  if (!ask) return 0;
  const answers = byIdList<Answer>(parseJsonResponse<unknown>(await generateBookText(req, ask.system, ask.user, 2500, 'book-cross-check')));
  const usable = (id: string) => {
    const a = answers.get(id);
    return a && typeof a.answer === 'string' && a.answer.trim() ? a : null;
  };

  // 2. Compare each answer with the book's statement.
  const pairs = targets
    .map((e, i) => {
      const a = usable(`q${i + 1}`);
      return a ? `q${i + 1}\nSTATEMENT: ${e.claim.statement}\nANSWER (${a.confidence ?? 'unknown'} confidence): ${a.answer}` : '';
    })
    .filter(Boolean);
  if (!pairs.length) return 0;
  const compare = buildPrompt(PROMPT_IDS.BOOK_CROSS_COMPARE, { pairs: pairs.join('\n\n') });
  if (!compare) return 0;
  const verdicts = byIdList<{ id: string; verdict?: string; correction?: string }>(
    parseJsonResponse<unknown>(await generateBookText(req, compare.system, compare.user, 1500, 'book-cross-compare')),
  );

  let changed = 0;
  const disagreements: Array<{ id: string; e: Evidence; answer: Answer; correction?: string }> = [];
  targets.forEach((e, i) => {
    const id = `q${i + 1}`;
    const a = usable(id);
    const v = verdicts.get(id);
    if (!a || !v) return;
    if (v.verdict === 'agree' && a.confidence !== 'low') {
      e.verdict = 'confirmed';
      e.source = 'cross-check';
      e.reference = 'independent expert answer';
      e.excerpt = a.answer;
      changed++;
    } else if (v.verdict === 'disagree' && a.confidence !== 'low') {
      disagreements.push({ id, e, answer: a, correction: v.correction });
    } else {
      e.excerpt = `${e.excerpt ? `${e.excerpt}\n` : ''}Independent answer (${a.confidence ?? 'unknown'} confidence, inconclusive): ${a.answer}`;
    }
  });

  // 3. A judge decides each disagreement; only a clear verdict changes anything.
  if (disagreements.length) {
    const judge = buildPrompt(PROMPT_IDS.BOOK_CROSS_JUDGE, {
      context,
      disputes: disagreements
        .map((d) => `${d.id}\nQUESTION: ${d.e.claim.question}\nSTATEMENT (book): ${d.e.claim.statement}\nANSWER (independent): ${d.answer.answer}`)
        .join('\n\n'),
    });
    const rulings = judge
      ? byIdList<{ id: string; winner?: string; confidence?: string; reason?: string }>(
          parseJsonResponse<unknown>(await generateBookText(req, judge.system, judge.user, 2000, 'book-cross-judge')),
        )
      : new Map();
    for (const d of disagreements) {
      const r = rulings.get(d.id);
      const reason = r?.reason ? ` Judge: ${r.reason}` : '';
      if (r?.winner === 'independent' && r.confidence === 'high') {
        d.e.verdict = 'disputed';
        d.e.source = 'cross-check';
        d.e.reference = 'independent expert answer, upheld by a judge';
        d.e.excerpt = `${d.answer.answer}${d.correction ? `\nSuggested correction: ${d.correction}` : ''}${reason}`;
        changed++;
      } else if (r?.winner === 'book' && r.confidence !== 'low') {
        d.e.verdict = 'confirmed';
        d.e.source = 'cross-check';
        d.e.reference = 'judged correct after an independent answer disagreed';
        d.e.excerpt = `Independent answer: ${d.answer.answer}.${reason}`;
        changed++;
      } else {
        d.e.contested = true;
        d.e.excerpt = `Uncertain — an independent answer differed (${d.answer.answer}) and a judge could not decide.${reason}`;
      }
    }
  }
  return changed;
}
