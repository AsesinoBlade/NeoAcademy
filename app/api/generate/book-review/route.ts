/**
 * Fact-check and technically review one written ebook section.
 *
 * POST /api/generate/book-review { bookId, sectionId, webSearch? }
 *
 *  1. Extract the section's checkable claims (commands, arguments, syntax,
 *     options, APIs, facts).
 *  2. Verify them: local tool docs first (e.g. `cmake --help-command`), then
 *     web search, else "unverified".
 *  3. A technical-editor pass fixes NOT FOUND / contradicted claims, code
 *     that violates the project spec, and leaked drafting ("Wait, ...").
 *  4. Guard rails: the corrected section must keep ≥75% of the words and all
 *     figures, otherwise the original is kept.
 *
 * Writes data/books/<id>/reviews/<sectionId>.json (audit trail). Idempotent.
 */
import { type NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { sanitiseSectionFigures } from '@/lib/book/figures';
import { extractClaims, generateBookText, tableOfContents } from '@/lib/book/llm';
import { buildProjectContext, extractProjectFiles, recordProjectFiles } from '@/lib/book/project';
import { formatEvidence, gatherEvidence } from '@/lib/book/references';
import {
  bookDir,
  countWords,
  listSectionRefs,
  parseSectionSpec,
  readBook,
  readSection,
  writeSection,
} from '@/lib/book/storage';

const log = createLogger('Book Review API');

export const runtime = 'nodejs';
export const maxDuration = 900;

const reviewPath = (bookId: string, sectionId: string) =>
  path.join(bookDir(bookId), 'reviews', `${sectionId}.json`);

const LEAK_RE = /^(?:>\s*)?(?:Wait[,.!]|Hmm[,.]|Actually,? (?:wait|no|let'?s)|Let me (?:re)?(?:check|think|fix))/gim;

function figureCount(markdown: string): number {
  return (markdown.match(/^[ \t]*```[ \t]*(chart|mermaid|image)\b/gm) || []).length;
}

export async function POST(req: NextRequest) {
  try {
    const { bookId, sectionId, webSearch } = (await req.json()) as {
      bookId: string;
      sectionId: string;
      webSearch?: boolean;
    };
    const book = await readBook(bookId);
    if (!book) return apiError('INVALID_REQUEST', 404, 'Book not found');
    const ref = listSectionRefs(book.outline).find((r) => r.id === sectionId);
    if (!ref) return apiError('INVALID_REQUEST', 400, `Unknown section ${sectionId}`);

    const existingReview = await fs.readFile(reviewPath(bookId, sectionId), 'utf-8').catch(() => null);
    if (existingReview) return apiSuccess({ sectionId, skipped: true });

    const original = await readSection(bookId, sectionId);
    if (!original) return apiError('INVALID_REQUEST', 409, `Section ${sectionId} is not written yet`);

    // 1-2. Claims and evidence
    const claims = await extractClaims(req, original.slice(0, 20000), 12).catch(() => []);
    const evidence = await gatherEvidence(claims, {
      webSearch: !!webSearch,
      provider: (req.headers.get('x-web-search-provider') || undefined) as
        | import('@/lib/web-search/search').WebSearchProviderChoice
        | undefined,
    });
    const notFound = evidence.filter((e) => e.verdict === 'not-found');
    const leaks = (original.match(LEAK_RE) || []).length;

    // 3. Technical editor pass
    const projectContext = book.projectSpec
      ? `## The running project (canonical)\n\n${await buildProjectContext(
          book.id,
          book.projectSpec,
          `${ref.spec}\n${original.slice(0, 4000)}`,
          10000,
        )}`
      : '';

    const prompts = buildPrompt(PROMPT_IDS.BOOK_REVIEW, {
      bookTitle: book.title,
      tableOfContents: tableOfContents(book.outline, (p) => parseSectionSpec(p).title),
      projectContext,
      evidence: formatEvidence(evidence),
      sectionNumber: ref.sectionNumber,
      sectionTitle: ref.title,
      section: original,
    });
    if (!prompts) return apiError('INTERNAL_ERROR', 500, 'Book review prompt not found');

    const raw = await generateBookText(req, prompts.system, prompts.user, 14000, 'book-review');
    const corrections = (raw.match(/<corrections>([\s\S]*?)<\/corrections>/i)?.[1] ?? '')
      .split('\n')
      .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
      .filter((l) => l && !/^none\.?$/i.test(l));
    let revised = raw.match(/<section>([\s\S]*?)(?:<\/section>|$)/i)?.[1]?.trim() ?? '';

    // Strip a repeated title heading the editor might add.
    revised = revised.replace(/^#{1,2}\s+[^\n]*\n+/, '');

    // 4. Guard rails
    let accepted = false;
    let rejectedReason = '';
    if (corrections.length === 0 && leaks === 0) {
      rejectedReason = 'no corrections needed';
    } else if (!revised) {
      rejectedReason = 'editor returned no section';
    } else if (countWords(revised) < countWords(original) * 0.75) {
      rejectedReason = `revised section too short (${countWords(revised)} vs ${countWords(original)} words)`;
    } else if (figureCount(revised) < figureCount(original)) {
      rejectedReason = 'revised section dropped figures';
    } else {
      accepted = true;
    }

    if (accepted) {
      const imagesEnabled = req.headers.get('x-image-generation-enabled') === 'true';
      const cleaned = sanitiseSectionFigures(revised, sectionId, { imagesEnabled });
      await writeSection(bookId, sectionId, cleaned.markdown);
      if (book.projectSpec) {
        await recordProjectFiles(
          bookId,
          sectionId,
          extractProjectFiles(cleaned.markdown, book.projectSpec.files.map((f) => f.path)),
        );
      }
    }

    const report = {
      sectionId,
      sectionNumber: ref.sectionNumber,
      title: ref.title,
      reviewedAt: new Date().toISOString(),
      accepted,
      rejectedReason: rejectedReason || undefined,
      leakedReasoningLines: leaks,
      corrections,
      evidence: evidence.map((e) => ({
        identifier: e.claim.identifier,
        kind: e.claim.kind,
        tool: e.claim.tool,
        statement: e.claim.statement,
        verdict: e.verdict,
        source: e.source,
        reference: e.reference,
      })),
    };
    await fs.mkdir(path.dirname(reviewPath(bookId, sectionId)), { recursive: true });
    await fs.writeFile(reviewPath(bookId, sectionId), JSON.stringify(report, null, 2), 'utf-8');

    log.info(
      `Reviewed ${ref.sectionNumber}: ${claims.length} claim(s), ${notFound.length} not found` +
        `${notFound.length ? ` (${notFound.map((e) => e.claim.identifier).join(', ')})` : ''}, ` +
        `${corrections.length} correction(s), ${accepted ? 'applied' : `kept original — ${rejectedReason}`}`,
    );

    return apiSuccess({
      sectionId,
      claims: claims.length,
      notFound: notFound.length,
      corrections: corrections.length,
      accepted,
    });
  } catch (error) {
    log.error('Book review failed:', error);
    return apiError('GENERATION_FAILED', 500, error instanceof Error ? error.message : String(error));
  }
}
