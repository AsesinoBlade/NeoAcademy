/**
 * Keeping a book consistent with itself.
 *
 *  - Premise check: before planning, the request's assumptions are judged
 *    against the evidence (supported / contested / unsupported / false) and
 *    given an editorial treatment. Stored on the book; every writer and
 *    reviewer sees it.
 *  - Principles ledger: after each reviewed section, the principles it
 *    establishes are appended to data/books/<id>/principles.json. Later
 *    sections are written against the list and checked for contradictions.
 *  - Consistency check: per section, recommendations that contradict a
 *    principle or a premise verdict are listed for the technical editor.
 */
import type { NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseJsonResponse } from '@/lib/generation/json-repair';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import { createLogger } from '@/lib/logger';
import { generateBookText } from './llm';
import { bookDir } from './storage';

const log = createLogger('BookPrinciples');

export interface PremiseFinding {
  premise: string;
  verdict: 'supported' | 'contested' | 'unsupported' | 'false';
  explanation: string;
  treatment: string;
}

export interface Principle {
  statement: string;
  sectionId: string;
}

export interface ConsistencyConflict {
  quote: string;
  conflictsWith: string;
  why: string;
  fix: string;
}

const VERDICTS = new Set(['supported', 'contested', 'unsupported', 'false']);
const MAX_PRINCIPLES = 80;

// ── Premises ────────────────────────────────────────────────────────────

export async function checkPremises(
  req: NextRequest,
  requirement: string,
  researchContext?: string,
): Promise<PremiseFinding[]> {
  const prompts = buildPrompt(PROMPT_IDS.BOOK_PREMISES, {
    requirement,
    researchContext: researchContext?.slice(0, 8000) || '(none)',
  });
  if (!prompts) return [];
  const raw = await generateBookText(req, prompts.system, prompts.user, 4000, 'book-premises');
  const parsed = parseJsonResponse<unknown>(raw);
  return (Array.isArray(parsed) ? parsed : [])
    .filter(
      (p): p is PremiseFinding =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as PremiseFinding).premise === 'string' &&
        VERDICTS.has((p as PremiseFinding).verdict),
    )
    .slice(0, 10)
    .map((p) => ({
      premise: p.premise.trim(),
      verdict: p.verdict,
      explanation: String(p.explanation ?? '').trim(),
      treatment: String(p.treatment ?? '').trim(),
    }));
}

/** Premise stance as prompt text (non-supported premises first). */
export function formatPremises(premises: PremiseFinding[] | undefined): string {
  if (!premises?.length) return '(no premise check was run)';
  const order = { false: 0, unsupported: 1, contested: 2, supported: 3 } as const;
  return [...premises]
    .sort((a, b) => order[a.verdict] - order[b.verdict])
    .map(
      (p) =>
        `- [${p.verdict.toUpperCase()}] ${p.premise}\n  Evidence: ${p.explanation}\n  How the book treats it: ${p.treatment}`,
    )
    .join('\n');
}

// ── Principles ledger ─────────────────────────────────────────────────────

const principlesPath = (bookId: string) => path.join(bookDir(bookId), 'principles.json');

export async function readPrinciples(bookId: string): Promise<Principle[]> {
  try {
    return JSON.parse(await fs.readFile(principlesPath(bookId), 'utf-8')) as Principle[];
  } catch {
    return [];
  }
}

export function formatPrinciples(principles: Principle[]): string {
  if (principles.length === 0) return '(none yet)';
  return principles.map((p, i) => `${i + 1}. ${p.statement} (from ${p.sectionId})`).join('\n');
}

/** Record the principles a (reviewed) section establishes. Returns how many were added. */
export async function recordSectionPrinciples(
  req: NextRequest,
  bookId: string,
  sectionId: string,
  sectionNumber: string,
  sectionTitle: string,
  markdown: string,
): Promise<number> {
  const existing = await readPrinciples(bookId);
  // Idempotent per section (a re-review replaces that section's principles).
  const others = existing.filter((p) => p.sectionId !== sectionId);
  if (others.length >= MAX_PRINCIPLES) return 0;

  const prompts = buildPrompt(PROMPT_IDS.BOOK_PRINCIPLES, {
    existing: formatPrinciples(others),
    sectionNumber,
    sectionTitle,
    section: markdown.slice(0, 20000),
    maxNew: Math.min(6, MAX_PRINCIPLES - others.length),
  });
  if (!prompts) return 0;
  const raw = await generateBookText(req, prompts.system, prompts.user, 1500, 'book-principles');
  const parsed = parseJsonResponse<unknown>(raw);
  const fresh = (Array.isArray(parsed) ? parsed : [])
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 10)
    .slice(0, 6)
    .map((statement) => ({ statement: statement.trim(), sectionId }));

  await fs.mkdir(bookDir(bookId), { recursive: true });
  await fs.writeFile(principlesPath(bookId), JSON.stringify([...others, ...fresh], null, 2), 'utf-8');
  if (fresh.length) log.info(`${sectionNumber}: recorded ${fresh.length} principle(s)`);
  return fresh.length;
}

// ── Consistency check ─────────────────────────────────────────────────────

export async function checkConsistency(
  req: NextRequest,
  args: {
    principles: Principle[];
    premises?: PremiseFinding[];
    sectionNumber: string;
    sectionTitle: string;
    section: string;
  },
): Promise<ConsistencyConflict[]> {
  if (args.principles.length === 0 && !args.premises?.some((p) => p.verdict !== 'supported')) return [];
  const prompts = buildPrompt(PROMPT_IDS.BOOK_CONSISTENCY, {
    principles: formatPrinciples(args.principles),
    premises: formatPremises(args.premises),
    sectionNumber: args.sectionNumber,
    sectionTitle: args.sectionTitle,
    section: args.section.slice(0, 20000),
  });
  if (!prompts) return [];
  const raw = await generateBookText(req, prompts.system, prompts.user, 3000, 'book-consistency');
  const parsed = parseJsonResponse<unknown>(raw);
  return (Array.isArray(parsed) ? parsed : [])
    .filter(
      (c): c is ConsistencyConflict =>
        !!c && typeof c === 'object' && typeof (c as ConsistencyConflict).quote === 'string',
    )
    .slice(0, 12)
    .map((c) => ({
      quote: c.quote.trim(),
      conflictsWith: String(c.conflictsWith ?? '').trim(),
      why: String(c.why ?? '').trim(),
      fix: String(c.fix ?? '').trim(),
    }));
}

export function formatConflicts(conflicts: ConsistencyConflict[]): string {
  if (conflicts.length === 0) return '(no conflicts found)';
  return conflicts
    .map(
      (c, i) =>
        `${i + 1}. "${c.quote}"\n   Contradicts: ${c.conflictsWith}\n   Why: ${c.why}\n   Rewrite: ${c.fix}`,
    )
    .join('\n');
}
