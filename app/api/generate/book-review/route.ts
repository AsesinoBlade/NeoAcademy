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
import { figuresAsText, sanitiseSectionFigures } from '@/lib/book/figures';
import { cleanEditorialArtifacts } from '@/lib/book/cleanup';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import type { Evidence } from '@/lib/book/references';
import { checkSectionMath, extractClaims, generateBookText, tableOfContents } from '@/lib/book/llm';
import { buildProjectContext, extractProjectFiles, listProjectFiles, projectDir, recordProjectFiles } from '@/lib/book/project';
import { checkCodeSamples, formatCodeReport, type CodeCheckReport } from '@/lib/book/code-check';
import { bookLibraries } from '@/lib/book/auto-references';
import { crossCheckUnverified } from '@/lib/book/cross-check';
import { checkAgainstDocumentation } from '@/lib/book/doc-check';
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
  writeBook,
  writeSection,
} from '@/lib/book/storage';

const log = createLogger('Book Review API');

export const runtime = 'nodejs';
export const maxDuration = 900;

const reviewPath = (bookId: string, sectionId: string) =>
  path.join(bookDir(bookId), 'reviews', `${sectionId}.json`);

const LEAK_RE = /^(?:>\s*)?(?:Wait[,.!]|Hmm[,.]|Actually,? (?:wait|no|let'?s)|Let me (?:re)?(?:check|think|fix))/gim;

/** Every directory above a project header, so samples' #include <...> resolve. */
async function projectIncludeDirs(bookId: string): Promise<string[]> {
  const dirs = new Set<string>();
  for (const f of await listProjectFiles(bookId)) {
    if (!/\.(h|hh|hpp|hxx|inl)$/i.test(f.path)) continue;
    let d = path.dirname(f.path);
    while (d && d !== '.') {
      dirs.add(path.join(projectDir(bookId), d));
      d = path.dirname(d);
    }
  }
  return [...dirs];
}

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
    // Figures (chart data, captions) are fact-checked too, as plain sentences.
    // Dense technical sections need more checks: about one claim per 90 words, 12–30.
    const maxClaims = Math.min(30, Math.max(12, Math.round(countWords(original) / 90)));
    const claims = await extractClaims(req, figuresAsText(original).slice(0, 24000), maxClaims).catch(() => []);
    const evidence = await gatherEvidence(claims, {
      webSearch: !!webSearch,
      libraries: bookLibraries(book),
          projectText: book.projectSpec
            ? (await listProjectFiles(book.id)).map((f) => f.content).join('\n')
            : undefined,
      provider: (req.headers.get('x-web-search-provider') || undefined) as
        | import('@/lib/web-search/search').WebSearchProviderChoice
        | undefined,
    });
    // Documentation-confirmed names: does the book describe them correctly?
    const docContradictions = await checkAgainstDocumentation(req, evidence).catch((error) => {
      log.warn(`Documentation meaning check failed for ${ref.sectionNumber}:`, error);
      return 0;
    });
    if (docContradictions) log.info(`${ref.sectionNumber}: ${docContradictions} claim(s) contradict their documentation`);

    // Claims nothing could verify get an independent cross-check.
    const crossChecked = await crossCheckUnverified(req, evidence, `${book.title} — ${ref.title}`).catch((error) => {
      log.warn(`Cross-check failed for ${ref.sectionNumber}:`, error);
      return 0;
    });
    const notFound = evidence.filter((e) => e.verdict === 'not-found');
    const disputed = evidence.filter((e) => e.verdict === 'disputed');
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

    // Code samples: compiled with the real compilers.
    // Plans approved before check calibration existed: calibrate on first use.
    if (book.verificationPlan?.decision?.approved && book.verificationPlan.checks.some((c) => !c.calibration)) {
      const { calibrateChecks } = await import('@/lib/book/code-check');
      await calibrateChecks(book.verificationPlan);
      await writeBook(book);
      for (const c of book.verificationPlan.checks) log.info(`Check "${c.label}": ${c.calibration?.status}`);
    }
    const codeOptions = {
      skipProjectFiles: !!book.projectSpec,
      projectRoot: book.projectSpec ? projectDir(bookId) : undefined,
      includeDirs: book.projectSpec ? await projectIncludeDirs(bookId) : [],
      plan: book.verificationPlan,
    };
    const code = await checkCodeSamples(original, codeOptions).catch((error) => {
      log.warn(`Code check failed for ${ref.sectionNumber}:`, error);
      return { checked: 0, withErrors: 0, results: [], unavailable: [] } as CodeCheckReport;
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
      codeReport: formatCodeReport(code),
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
    if (corrections.length === 0 && leaks === 0 && !(math && math.wrong > 0) && conflicts.length === 0 && code.withErrors === 0 && disputed.length === 0) {
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

    // Re-verify maths and code in the revised text; one targeted fix round
    // for anything still wrong, then verify again.
    let mathAfter: Awaited<ReturnType<typeof checkSectionMath>> = null;
    let codeAfter: CodeCheckReport | null = null;
    if (accepted) {
      if (math) mathAfter = await checkSectionMath(req, revised).catch(() => null);
      if (code.checked > 0) codeAfter = await checkCodeSamples(revised, codeOptions).catch(() => null);
      const mathLeft = mathAfter?.wrong ?? 0;
      const codeLeft = codeAfter?.withErrors ?? 0;
      if (mathLeft > 0 || codeLeft > 0) {
        log.warn(
          `${ref.sectionNumber}: ${mathLeft} calculation(s) and ${codeLeft} code sample(s) still wrong after review — targeted fix`,
        );
        const fixPrompts = buildPrompt(PROMPT_IDS.BOOK_REVIEW, {
          bookTitle: book.title,
          tableOfContents: tableOfContents(book.outline, (p) => parseSectionSpec(p).title),
          projectContext,
          evidence: '(already reviewed — only fix the calculations marked WRONG and the code samples that DO NOT COMPILE)',
          mathReport: mathAfter ? mathAfter.report : '(already reviewed)',
          codeReport: codeAfter ? formatCodeReport(codeAfter) : '(already reviewed)',
          consistency: '(already reviewed)',
          premiseStance: formatPremises(book.premises),
          sectionNumber: ref.sectionNumber,
          sectionTitle: ref.title,
          section: revised,
        });
        if (fixPrompts) {
          const fixRaw = await generateBookText(req, fixPrompts.system, fixPrompts.user, 14000, 'book-review-fix');
          const fixed = (fixRaw.match(/<section>([\s\S]*?)(?:<\/section>|$)/i)?.[1] ?? '').trim().replace(/^#{1,2}\s+[^\n]*\n+/, '');
          if (fixed && countWords(fixed) >= countWords(original) * 0.75 && figureCount(fixed) >= figureCount(original)) {
            const mathRe = mathAfter ? await checkSectionMath(req, fixed).catch(() => null) : null;
            const codeRe = codeAfter ? await checkCodeSamples(fixed, codeOptions).catch(() => null) : null;
            const better =
              (mathRe?.wrong ?? mathLeft) + (codeRe?.withErrors ?? codeLeft) <= mathLeft + codeLeft;
            if (better) {
              revised = fixed;
              mathAfter = mathRe ?? mathAfter;
              codeAfter = codeRe ?? codeAfter;
              corrections.push(...(fixRaw.match(/<corrections>([\s\S]*?)<\/corrections>/i)?.[1] ?? '')
                .split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter((l) => l && !/^none\.?$/i.test(l)));
            }
          }
        }
      }
    }

    if (accepted) revised = cleanEditorialArtifacts(revised);

    // What the final text says about each open claim: still claimed, changed or
    // removed. The audit (and the book's verification appendix) reports this
    // final state, not the draft's.
    const reviewedText = accepted ? revised : original;
    const open = evidence.filter((e) => e.verdict !== 'confirmed');
    const afterReview = new Map<Evidence, 'still' | 'changed' | 'removed'>();
    if (open.length && accepted) {
      const resolution = buildPrompt(PROMPT_IDS.BOOK_RESOLUTION, {
        statements: open.slice(0, 25).map((e, i) => `s${i + 1}. ${e.claim.statement}`).join('\n'),
        section: figuresAsText(reviewedText).slice(0, 24000),
      });
      if (resolution) {
        const raw = await generateBookText(req, resolution.system, resolution.user, 1500, 'book-resolution').catch(() => '');
        const parsed = parseJsonResponse<unknown>(raw);
        for (const item of Array.isArray(parsed) ? parsed : []) {
          const { id, status } = (item ?? {}) as { id?: string; status?: string };
          const e = open[Number(String(id).replace(/^s/, '')) - 1];
          if (e && (status === 'still' || status === 'changed' || status === 'removed')) afterReview.set(e, status);
        }
      }
    }
    for (const e of open) if (!afterReview.has(e)) afterReview.set(e, 'still');

    // Claims found wrong (by documentation or a judged cross-check) that the
    // review left in the text get one targeted fix round, then a re-check.
    const stillWrong = open.filter((e) => (e.verdict === 'not-found' || e.verdict === 'disputed') && afterReview.get(e) === 'still');
    if (accepted && stillWrong.length) {
      log.warn(`${ref.sectionNumber}: ${stillWrong.length} claim(s) found wrong but still in the text — targeted fix`);
      const fixPrompts = buildPrompt(PROMPT_IDS.BOOK_REVIEW, {
        bookTitle: book.title,
        tableOfContents: tableOfContents(book.outline, (p) => parseSectionSpec(p).title),
        projectContext,
        evidence:
          'ONLY fix these claims: each was found WRONG and is still in the section. Correct every place in the section that makes the claim (prose, tables, code, captions), using the evidence.\n\n' +
          formatEvidence(stillWrong),
        mathReport: '(already reviewed)',
        codeReport: '(already reviewed)',
        consistency: '(already reviewed)',
        premiseStance: formatPremises(book.premises),
        sectionNumber: ref.sectionNumber,
        sectionTitle: ref.title,
        section: revised,
      });
      if (fixPrompts) {
        const fixRaw = await generateBookText(req, fixPrompts.system, fixPrompts.user, 14000, 'book-review-claims-fix').catch(() => '');
        const fixed = cleanEditorialArtifacts((fixRaw.match(/<section>([\s\S]*?)(?:<\/section>|$)/i)?.[1] ?? '').trim().replace(/^#{1,2}\s+[^\n]*\n+/, ''));
        if (fixed && countWords(fixed) >= countWords(original) * 0.75 && figureCount(fixed) >= figureCount(original)) {
          const recheck = buildPrompt(PROMPT_IDS.BOOK_RESOLUTION, {
            statements: stillWrong.map((e, i) => `s${i + 1}. ${e.claim.statement}`).join('\n'),
            section: figuresAsText(fixed).slice(0, 24000),
          });
          const raw = recheck ? await generateBookText(req, recheck.system, recheck.user, 1200, 'book-resolution').catch(() => '') : '';
          const parsed = parseJsonResponse<unknown>(raw);
          let resolved = 0;
          for (const item of Array.isArray(parsed) ? parsed : []) {
            const { id, status } = (item ?? {}) as { id?: string; status?: string };
            const e = stillWrong[Number(String(id).replace(/^s/, '')) - 1];
            if (e && (status === 'changed' || status === 'removed')) {
              afterReview.set(e, status);
              resolved++;
            }
          }
          if (resolved > 0) {
            revised = fixed;
            corrections.push(...(fixRaw.match(/<corrections>([\s\S]*?)<\/corrections>/i)?.[1] ?? '')
              .split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter((l) => l && !/^none\.?$/i.test(l)));
          }
          log.info(`${ref.sectionNumber}: targeted fix corrected ${resolved} of ${stillWrong.length} claim(s)`);
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
      code: {
        checked: code.checked,
        withErrorsBefore: code.withErrors,
        withErrorsAfter: accepted ? (codeAfter?.withErrors ?? (code.checked ? 0 : null)) : code.withErrors,
        unavailable: code.unavailable,
        samples: code.results.map((r) => ({ quote: r.sample.quote, lang: r.sample.lang, status: r.status, messages: r.messages })),
      },
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
        ...(e.verdict === 'disputed' || e.contested ? { independentAnswer: e.excerpt.slice(0, 600) } : {}),
        ...(e.contested ? { contested: true } : {}),
        ...(afterReview.has(e) ? { afterReview: afterReview.get(e) } : {}),
      })),
    };
    await fs.mkdir(path.dirname(reviewPath(bookId, sectionId)), { recursive: true });
    await fs.writeFile(reviewPath(bookId, sectionId), JSON.stringify(report, null, 2), 'utf-8');

    log.info(
      `Reviewed ${ref.sectionNumber}: ${claims.length} claim(s), ${notFound.length} not found` +
        `${notFound.length ? ` (${notFound.map((e) => e.claim.identifier).join(', ')})` : ''}, ` +
        `${corrections.length} correction(s), ${accepted ? 'applied' : `kept original — ${rejectedReason}`}` +
        `; ${conflicts.length} consistency conflict(s), ${newPrinciples} new principle(s)` +
        (crossChecked ? `; cross-check: ${crossChecked} claim(s) settled, ${disputed.length} disputed` : '') +
        (code.checked ? `; code: ${code.checked} sample(s) compiled, ${code.withErrors} with errors${accepted && codeAfter ? ` → ${codeAfter.withErrors} after review` : ''}` : '') +
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
      codeChecked: code.checked,
      codeErrors: code.withErrors,
      codeErrorsAfter: accepted ? (codeAfter?.withErrors ?? 0) : code.withErrors,
    });
  } catch (error) {
    log.error('Book review failed:', error);
    return apiError('GENERATION_FAILED', 500, error instanceof Error ? error.message : String(error));
  }
}
