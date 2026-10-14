/**
 * Shared LLM helpers for the ebook routes.
 */
import type { NextRequest } from 'next/server';

import { streamLLM } from '@/lib/ai/llm';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import { resolveGenerationModelFromHeaders } from '@/lib/server/resolve-model';
import type { Claim } from './references';

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<\/?think>\s*/gi, '').trim();
}

/**
 * Generate text with the request's model. Streams internally so long
 * generations don't hit the ~5 minute response-header timeout.
 */
export async function generateBookText(
  req: NextRequest,
  system: string,
  prompt: string,
  maxOutputTokens: number,
  label: string,
): Promise<string> {
  const { model } = resolveGenerationModelFromHeaders(req);
  const result = streamLLM({ model, system, prompt, maxOutputTokens }, label);
  let text = '';
  for await (const chunk of result.textStream) text += chunk;
  return stripThinking(text);
}

const CLAIM_KINDS = new Set([
  'command', 'command-argument', 'variable', 'property', 'module',
  'generator-expression', 'cli-option', 'api', 'fact',
]);

/** Ask the model for the checkable claims in a piece of text. */
export async function extractClaims(req: NextRequest, text: string, maxClaims: number): Promise<Claim[]> {
  const prompts = buildPrompt(PROMPT_IDS.BOOK_CLAIMS, { text, maxClaims });
  if (!prompts) return [];
  const raw = await generateBookText(req, prompts.system, prompts.user, 3000, 'book-claims');
  const parsed = parseJsonResponse<unknown>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (c): c is Claim =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as Claim).identifier === 'string' &&
        CLAIM_KINDS.has((c as Claim).kind) &&
        typeof (c as Claim).statement === 'string',
    )
    .slice(0, maxClaims)
    .map((c) => ({ ...c, tool: c.tool?.toLowerCase() }));
}

/** Compact table of contents used by several book prompts. */
export function tableOfContents(
  outline: Array<{ title: string; keyPoints?: string[] }>,
  sectionTitle: (raw: string) => string,
): string {
  return outline
    .map(
      (ch, ci) =>
        `${ci + 1}. ${ch.title}\n` +
        (ch.keyPoints || [])
          .filter((p) => p.trim())
          .map((p, si) => `   ${ci + 1}.${si + 1} ${sectionTitle(p)}`)
          .join('\n'),
    )
    .join('\n');
}

/** A title that is really the user's prompt (the old fallback) is not a title. */
export function looksLikePromptTitle(title: string, requirement: string): boolean {
  const t = title.trim().toLowerCase();
  return (
    !t ||
    t.length > 120 ||
    (requirement.trim().length > 0 && requirement.toLowerCase().startsWith(t.slice(0, 60)))
  );
}

/**
 * Transcribe a section's calculations (model) and evaluate them (Python).
 * Returns null when Python/numpy/sympy are unavailable — the caller then
 * reports the section as "math not verified" rather than failing.
 */
export async function checkSectionMath(
  req: NextRequest,
  text: string,
): Promise<{
  checks: import('./math').MathCheck[];
  results: import('./math').MathResult[];
  report: string;
  wrong: number;
} | null> {
  const { runMathChecks, formatMathResults, findMathPython } = await import('./math');
  if (!(await findMathPython()).ok) return null;

  const prompts = buildPrompt(PROMPT_IDS.BOOK_MATH, { text: text.slice(0, 24000), maxChecks: 30 });
  if (!prompts) return null;
  const raw = await generateBookText(req, prompts.system, prompts.user, 6000, 'book-math');
  const parsed = parseJsonResponse<unknown>(raw);
  const checks = (Array.isArray(parsed) ? parsed : [])
    .filter((c): c is import('./math').MathCheck => {
      if (!c || typeof c !== 'object') return false;
      const k = c as import('./math').MathCheck;
      if (k.kind === 'identity') return typeof k.lhs === 'string' && typeof k.rhs === 'string';
      if (k.kind === 'assert') return typeof k.expression === 'string';
      return typeof k.expression === 'string' && k.claimed !== undefined;
    })
    .slice(0, 30)
    .map((c, i) => ({
      ...c,
      id: `m${i + 1}`,
      kind: c.kind ?? 'value',
      quote: String(c.quote ?? '').slice(0, 160),
      description: String(c.description ?? ''),
      claimed: c.claimed === undefined ? undefined : String(c.claimed),
    }));

  const results = await runMathChecks(checks);
  if (!results) return null;
  return {
    checks,
    results,
    report: formatMathResults(checks, results),
    wrong: results.filter((r) => r.ok === false).length,
  };
}
