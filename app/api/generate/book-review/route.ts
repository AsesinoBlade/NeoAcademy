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
import { checkSectionMath, extractClaims, generateBookText, tableOfContents } from '@/lib/book/llm';
import { buildProjectContext, extractProjectFiles, recordProjectFiles } from '@/lib/book/project';
import { formatEvidence, gatherEvidence } from '@/lib/book/references';
import {
  checkConsistency,
  formatConflicts,
  formatPremises,
  readPrinciples,
  recordSectionPrinciples,
} from '@/lib/book/principles';
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

    // Calculations: transcribed by the model, evaluated by Python (authoritative).
    const math = await checkSectionMath(req, original).catch((error) => {
      log.warn(`Math check failed for ${ref.sectionNumber}:`, error);
      return null;
    });
    // Consistency: does the advice follow from the book's own principles and
    // its stance on the request's premises?
    const principles = await readPrinciples(bookId);
    const conflicts = await checkConsistency(req, {
      principles: principles.filter((p) => p.sectionId !== sectionId),
      premises: book.premises,
      sectionNumber: ref.sectionNumber,
      sectionTitle: ref.title,
      section: original,
    }).catch((error) => {
      log.warn(`Consistency check failed for ${ref.sectionNumber}:`, error);
      return [];
    });

    const mathReport = math
      ? math.report
      : 'Not available (Python with numpy and sympy was not found) — check every calculation carefully yourself.';

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
      mathReport,
      consistency: formatConflicts(conflicts),
      premiseStance: formatPremises(book.premises),
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
    if (corrections.length === 0 && leaks === 0 && !(math && math.wrong > 0) && conflicts.length === 0) {
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

    // Re-verify the maths of the revised text; one targeted fix round for
    // anything still wrong, then verify again.
    let mathAfter: Awaited<ReturnType<typeof checkSectionMath>> = null;
    if (accepted && math) {
      mathAfter = await checkSectionMath(req, revised).catch(() => null);
      if (mathAfter && mathAfter.wrong > 0) {
        log.warn(`${ref.sectionNumber}: ${mathAfter.wrong} calculation(s) still wrong after review — targeted fix`);
        const fixPrompts = buildPrompt(PROMPT_IDS.BOOK_REVIEW, {
          bookTitle: book.title,
          tableOfContents: tableOfContents(book.outline, (p) => parseSectionSpec(p).title),
          projectContext,
          evidence: '(already reviewed — only fix the calculations marked WRONG)',
          mathReport: mathAfter.report,
          consistency: '(already reviewed)',
          premiseStance: formatPremises(book.premises),
          sectionNumber: ref.sectionNumber,
          sectionTitle: ref.title,
          section: revised,
        });
        if (fixPrompts) {
          const fixRaw = await generateBookText(req, fixPrompts.system, fixPrompts.user, 14000, 'book-review-math');
          const fixed = (fixRaw.match(/<section>([\s\S]*?)(?:<\/section>|$)/i)?.[1] ?? '').trim().replace(/^#{1,2}\s+[^\n]*\n+/, '');
          if (fixed && countWords(fixed) >= countWords(original) * 0.75 && figureCount(fixed) >= figureCount(original)) {
            const recheck = await checkSectionMath(req, fixed).catch(() => null);
            if (!recheck || recheck.wrong <= mathAfter.wrong) {
              revised = fixed;
              mathAfter = recheck ?? mathAfter;
              corrections.push(...(fixRaw.match(/<corrections>([\s\S]*?)<\/corrections>/i)?.[1] ?? '')
                .split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter((l) => l && !/^none\.?$/i.test(l)));
            }
          }
        }
      }
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

    // Principles ledger: record what this section establishes, from the final text.
    const finalText = accepted ? ((await readSection(bookId, sectionId)) ?? revised) : original;
    const newPrinciples = await recordSectionPrinciples(
      req,
      bookId,
      sectionId,
      ref.sectionNumber,
      ref.title,
      finalText,
    ).catch((error) => {
      log.warn(`Recording principles failed for ${ref.sectionNumber}:`, error);
      return 0;
    });

    const report = {
      sectionId,
      sectionNumber: ref.sectionNumber,
      title: ref.title,
      reviewedAt: new Date().toISOString(),
      accepted,
      rejectedReason: rejectedReason || undefined,
      leakedReasoningLines: leaks,
      consistencyConflicts: conflicts,
      math: math
        ? {
            checked: math.checks.length,
            wrongBefore: math.wrong,
            wrongAfter: accepted ? (mathAfter?.wrong ?? null) : math.wrong,
            unverifiable: math.results.filter((r) => r.ok === null).length,
            details: math.checks.map((c) => {
              const r = math.results.find((x) => x.id === c.id);
              return { quote: c.quote, expression: c.expression ?? `${c.lhs} == ${c.rhs}`, claimed: c.claimed, computed: r?.computed, ok: r?.ok, error: r?.error };
            }),
          }
        : { available: false },
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
        `${corrections.length} correction(s), ${accepted ? 'applied' : `kept original — ${rejectedReason}`}` +
        `; ${conflicts.length} consistency conflict(s), ${newPrinciples} new principle(s)` +
        (math ? `; math: ${math.checks.length} checked, ${math.wrong} wrong${accepted && mathAfter ? ` → ${mathAfter.wrong} after review` : ''}` : '; math: not verified'),
    );

    return apiSuccess({
      sectionId,
      claims: claims.length,
      notFound: notFound.length,
      corrections: corrections.length,
      accepted,
      mathChecked: math?.checks.length ?? 0,
      mathWrong: math?.wrong ?? 0,
      mathWrongAfter: accepted ? (mathAfter?.wrong ?? null) : (math?.wrong ?? null),
      conflicts: conflicts.length,
      newPrinciples,
    });
  } catch (error) {
    log.error('Book review failed:', error);
    return apiError('GENERATION_FAILED', 500, error instanceof Error ? error.message : String(error));
  }
}
