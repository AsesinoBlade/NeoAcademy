/**
 * Whole-book consistency pass, after every section is written and reviewed.
 *
 * Per-section review only compares a section with a short ledger, so a book
 * can still say "15–20%" in chapter 1 and "25%" in chapter 3. This pass:
 *   1. lists the checkable facts of each chapter (numbers, definitions, rules,
 *      directions) from the FINAL text;
 *   2. finds topics where sections disagree, and the statement they should all make;
 *   3. edits only the disagreeing sentences (confident resolutions only);
 *   4. records everything for the reader's appendix — resolved ones as
 *      "made consistent, please double-check", unsure ones as open.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';

import { parseJsonResponse } from '@/lib/generation/json-repair';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import { createLogger } from '@/lib/logger';
import { cleanEditorialArtifacts, stripLeakedPrompt } from './cleanup';
import { generateBookText } from './llm';
import { bookDir, countWords, listSectionRefs, readBook, readSection, writeSection, type SectionRef } from './storage';

const log = createLogger('BookFinalConsistency');

export interface BookFact {
  topic: string;
  section: string;
  statement: string;
}

export interface Contradiction {
  topic: string;
  sections: string[];
  versions: string[];
  correct: string;
  confidence: 'high' | 'medium' | 'low';
  reason?: string;
  /** Sections edited to agree (section numbers). */
  applied: string[];
  /** Sections whose edit was rejected by the guard rails. */
  failed?: string[];
}

export interface FinalConsistencyReport {
  checkedAt: string;
  facts: number;
  contradictions: Contradiction[];
}

export const finalConsistencyPath = (bookId: string) => path.join(bookDir(bookId), 'consistency-final.json');

export async function readFinalConsistency(bookId: string): Promise<FinalConsistencyReport | null> {
  return fs
    .readFile(finalConsistencyPath(bookId), 'utf-8')
    .then((t) => JSON.parse(t) as FinalConsistencyReport)
    .catch(() => null);
}

const CHAPTER_CHARS = 60000;
const FACT_BATCH = 150;

const figureCount = (md: string) => (md.match(/^[ \t]*```/gm) || []).length;

async function chapterFacts(req: NextRequest, bookId: string, bookTitle: string, chapterIndex: number, chapterTitle: string, refs: SectionRef[]): Promise<BookFact[]> {
  const parts: string[] = [];
  for (const r of refs) {
    const md = await readSection(bookId, r.id);
    if (md) parts.push(`### ${r.sectionNumber} ${r.title}\n\n${md}`);
  }
  const text = parts.join('\n\n');
  if (!text.trim()) return [];
  // Cache by content, so a resumed run doesn't re-extract unchanged chapters.
  const hash = createHash('sha1').update(text).digest('hex').slice(0, 12);
  const cache = path.join(bookDir(bookId), 'consistency', `facts-ch${chapterIndex + 1}-${hash}.json`);
  const cached = await fs.readFile(cache, 'utf-8').then((t) => JSON.parse(t) as BookFact[]).catch(() => null);
  if (cached) return cached;

  // Very long chapters are read in pieces (section boundaries).
  const chunks: string[] = [];
  let current = '';
  for (const p of parts) {
    if (current && current.length + p.length > CHAPTER_CHARS) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n\n' : '') + p.slice(0, CHAPTER_CHARS);
  }
  if (current) chunks.push(current);

  const facts: BookFact[] = [];
  for (const chunk of chunks) {
    const prompt = buildPrompt(PROMPT_IDS.BOOK_FACTS, {
      bookTitle,
      chapterNumber: String(chapterIndex + 1),
      chapterTitle,
      chapterText: chunk,
    });
    if (!prompt) continue;
    const raw = await generateBookText(req, prompt.system, prompt.user, 6000, 'book-facts');
    const list = parseJsonResponse<unknown>(raw);
    for (const f of Array.isArray(list) ? list : []) {
      const o = f as Partial<BookFact>;
      if (typeof o?.statement === 'string' && typeof o.topic === 'string' && typeof o.section === 'string') {
        facts.push({ topic: o.topic.trim().toLowerCase(), section: o.section.trim(), statement: o.statement.trim() });
      }
    }
  }
  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, JSON.stringify(facts, null, 2), 'utf-8');
  return facts;
}

async function findContradictions(req: NextRequest, bookTitle: string, facts: BookFact[]): Promise<Contradiction[]> {
  // Topics stated in only one section can't contradict anything... unless a
  // differently-worded key covers the same subject, so keep all facts but sort
  // by topic: similar keys end up in the same batch.
  const sorted = [...facts].sort((a, b) => a.topic.localeCompare(b.topic) || a.section.localeCompare(b.section, undefined, { numeric: true }));
  const out: Contradiction[] = [];
  for (let i = 0; i < sorted.length; i += FACT_BATCH) {
    const batch = sorted.slice(i, i + FACT_BATCH);
    let lastTopic = '';
    const lines: string[] = [];
    for (const f of batch) {
      if (f.topic !== lastTopic) lines.push(`\n[${(lastTopic = f.topic)}]`);
      lines.push(`- (${f.section}) ${f.statement}`);
    }
    const prompt = buildPrompt(PROMPT_IDS.BOOK_CONTRADICTIONS, { bookTitle, facts: lines.join('\n').trim() });
    if (!prompt) continue;
    const raw = await generateBookText(req, prompt.system, prompt.user, 6000, 'book-contradictions');
    const list = parseJsonResponse<unknown>(raw);
    for (const c of Array.isArray(list) ? list : []) {
      const o = c as Partial<Contradiction>;
      if (!o || typeof o.correct !== 'string' || !Array.isArray(o.sections) || o.sections.length < 2) continue;
      out.push({
        topic: String(o.topic ?? ''),
        sections: o.sections.map(String),
        versions: Array.isArray(o.versions) ? o.versions.map(String) : [],
        correct: o.correct,
        confidence: o.confidence === 'high' || o.confidence === 'medium' ? o.confidence : 'low',
        reason: typeof o.reason === 'string' ? o.reason : undefined,
        applied: [],
      });
    }
  }
  return out;
}

async function harmoniseSection(
  req: NextRequest,
  bookId: string,
  bookTitle: string,
  ref: SectionRef,
  statements: string[],
): Promise<boolean> {
  const original = await readSection(bookId, ref.id);
  if (!original) return false;
  const prompt = buildPrompt(PROMPT_IDS.BOOK_HARMONISE, {
    bookTitle,
    statements: statements.map((s) => `- ${s}`).join('\n'),
    sectionNumber: ref.sectionNumber,
    sectionTitle: ref.title,
    section: original,
  });
  if (!prompt) return false;
  const words = countWords(original);
  const raw = await generateBookText(req, prompt.system, prompt.user, Math.min(32000, Math.max(4000, Math.round(words * 2.5))), 'book-harmonise');
  let revised = raw.match(/<section>([\s\S]*?)(?:<\/section>|$)/i)?.[1]?.trim() ?? '';
  const leak = stripLeakedPrompt(revised);
  if (leak.leaked && !leak.recovered) return false;
  revised = cleanEditorialArtifacts(leak.text).replace(/^#{1,2}\s+[^\n]*\n+/, '');
  // Guard rails: same length (roughly), same figures and code blocks.
  if (!revised || countWords(revised) < words * 0.9 || figureCount(revised) !== figureCount(original)) {
    log.warn(`Consistency edit of ${ref.sectionNumber} rejected (${countWords(revised)} vs ${words} words)`);
    return false;
  }
  if (revised.trim() === original.trim()) return true;
  await writeSection(bookId, ref.id, revised);
  return true;
}

export async function runFinalConsistency(req: NextRequest, bookId: string, force = false): Promise<FinalConsistencyReport | null> {
  if (!force) {
    const existing = await readFinalConsistency(bookId);
    if (existing) return existing;
  }
  const book = await readBook(bookId);
  if (!book) return null;
  const refs = listSectionRefs(book.outline);
  const bookTitle = book.title;

  const facts: BookFact[] = [];
  for (let ci = 0; ci < book.outline.length; ci++) {
    const chapterRefs = refs.filter((r) => r.chapterIndex === ci);
    facts.push(...(await chapterFacts(req, bookId, bookTitle, ci, book.outline[ci].title, chapterRefs)));
  }
  log.info(`${bookId}: ${facts.length} fact(s) across ${book.outline.length} chapter(s)`);

  const contradictions = await findContradictions(req, bookTitle, facts);
  log.info(`${bookId}: ${contradictions.length} contradiction(s) between sections`);

  // Edit each affected section once, with every statement it must agree with.
  const bySection = new Map<string, Contradiction[]>();
  for (const c of contradictions) {
    if (c.confidence === 'low') continue;
    for (const s of c.sections) bySection.set(s, [...(bySection.get(s) ?? []), c]);
  }
  for (const [sectionNumber, list] of bySection) {
    const ref = refs.find((r) => r.sectionNumber === sectionNumber);
    if (!ref) continue;
    const ok = await harmoniseSection(req, bookId, bookTitle, ref, list.map((c) => c.correct)).catch((error) => {
      log.warn(`Consistency edit of ${sectionNumber} failed:`, error);
      return false;
    });
    for (const c of list) (ok ? c.applied : (c.failed ??= [])).push(sectionNumber);
  }

  const report: FinalConsistencyReport = { checkedAt: new Date().toISOString(), facts: facts.length, contradictions };
  await fs.writeFile(finalConsistencyPath(bookId), JSON.stringify(report, null, 2), 'utf-8');
  return report;
}
