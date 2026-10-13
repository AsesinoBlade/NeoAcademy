/**
 * Plan an ebook after its outline is approved: a real title/subtitle and,
 * for hands-on books, the canonical project specification every section
 * must follow (see lib/book/project.ts).
 *
 * POST /api/generate/book-plan { bookId, force? } → { title, subtitle, hasProject }
 * Idempotent: an already-planned book is returned as-is unless force=true.
 */
import { type NextRequest } from 'next/server';

import { parseJsonResponse } from '@/lib/generation/json-repair';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { generateBookText, looksLikePromptTitle, tableOfContents } from '@/lib/book/llm';
import type { ProjectSpec } from '@/lib/book/project';
import { parseSectionSpec, readBook, writeBook } from '@/lib/book/storage';

const log = createLogger('Book Plan API');

export const runtime = 'nodejs';
export const maxDuration = 600;

function validSpec(raw: unknown): ProjectSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const spec = raw as ProjectSpec;
  if (typeof spec.name !== 'string' || !Array.isArray(spec.files) || spec.files.length === 0) return null;
  return {
    name: spec.name,
    summary: String(spec.summary || ''),
    language: String(spec.language || ''),
    buildSystem: String(spec.buildSystem || ''),
    buildCommands: Array.isArray(spec.buildCommands) ? spec.buildCommands.map(String) : [],
    files: spec.files
      .filter((f) => f && typeof f.path === 'string')
      .map((f) => ({ path: f.path, purpose: String(f.purpose || ''), introducedInChapter: f.introducedInChapter })),
    components: Array.isArray(spec.components) ? spec.components.filter((c) => c && typeof c.name === 'string') : [],
    conventions: Array.isArray(spec.conventions) ? spec.conventions.map(String) : [],
  };
}

export async function POST(req: NextRequest) {
  try {
    const { bookId, force } = (await req.json()) as { bookId: string; force?: boolean };
    const book = await readBook(bookId);
    if (!book) return apiError('INVALID_REQUEST', 404, 'Book not found');

    const titleOk = !looksLikePromptTitle(book.title, book.requirement);
    if (!force && book.projectSpec !== undefined && titleOk) {
      return apiSuccess({ title: book.title, subtitle: book.subtitle, hasProject: !!book.projectSpec, skipped: true });
    }

    const prompts = buildPrompt(PROMPT_IDS.BOOK_PLAN, {
      requirement: book.requirement,
      outline: tableOfContents(book.outline, (p) => parseSectionSpec(p).title),
    });
    if (!prompts) return apiError('INTERNAL_ERROR', 500, 'Book plan prompt not found');

    const raw = await generateBookText(req, prompts.system, prompts.user, 6000, 'book-plan');
    const plan = parseJsonResponse<{ title?: string; subtitle?: string; project?: unknown }>(raw);
    if (!plan || typeof plan !== 'object') {
      return apiError('GENERATION_FAILED', 502, 'Book plan could not be parsed');
    }

    const title = titleOk ? book.title : plan.title?.trim() || book.title;
    const subtitle = book.subtitle || plan.subtitle?.trim() || undefined;
    const projectSpec = book.projectSpec !== undefined && !force ? book.projectSpec : validSpec(plan.project);

    await writeBook({ ...book, title, subtitle, projectSpec });
    log.info(
      `Planned "${title}": ${projectSpec ? `project "${projectSpec.name}" with ${projectSpec.files.length} files` : 'no hands-on project'}`,
    );
    return apiSuccess({ title, subtitle, hasProject: !!projectSpec });
  } catch (error) {
    log.error('Book plan failed:', error);
    return apiError('GENERATION_FAILED', 500, error instanceof Error ? error.message : String(error));
  }
}
