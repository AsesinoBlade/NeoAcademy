/**
 * Verify that a book's running project actually builds.
 *
 * POST /api/generate/book-verify { bookId, force? }
 *
 *  1. Run the project spec's build commands on a copy of the project files.
 *  2. On failure, the model gets the error + files and returns corrected
 *     complete files (up to 3 rounds).
 *  3. Fixed files are written back into the section that last showed them,
 *     so a reader following the chapters gets working code.
 *
 * Writes data/books/<id>/verify/report.json. Skips if already passed.
 */
import { type NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';

import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { generateBookText } from '@/lib/book/llm';
import { applyVerifiedFiles, extractProjectFiles, listProjectFiles } from '@/lib/book/project';
import { readBook, readSection, writeSection } from '@/lib/book/storage';
import {
  replaceFileBlock,
  runProjectBuild,
  verifyDir,
  verifyReportPath,
  type VerifyReport,
} from '@/lib/book/verify';

const log = createLogger('Book Verify API');

export const runtime = 'nodejs';
export const maxDuration = 3600;

const MAX_FIX_ROUNDS = 3;

export async function POST(req: NextRequest) {
  try {
    const { bookId, force } = (await req.json()) as { bookId: string; force?: boolean };
    const book = await readBook(bookId);
    if (!book) return apiError('INVALID_REQUEST', 404, 'Book not found');

    const previous = await fs
      .readFile(verifyReportPath(bookId), 'utf-8')
      .then((t) => JSON.parse(t) as VerifyReport)
      .catch(() => null);
    if (!force && previous?.status === 'passed') return apiSuccess({ ...previous, skipped: true });

    const save = async (report: VerifyReport) => {
      await fs.mkdir(verifyDir(bookId), { recursive: true });
      await fs.writeFile(verifyReportPath(bookId), JSON.stringify(report, null, 2), 'utf-8');
      return report;
    };

    const spec = book.projectSpec;
    const files = await listProjectFiles(bookId);
    if (!spec || files.length === 0 || spec.buildCommands.length === 0) {
      const report = await save({
        status: 'skipped',
        reason: !spec ? 'This book has no hands-on project.' : 'No project files or build commands to verify.',
        verifiedAt: new Date().toISOString(),
        toolchain: [],
        notes: [],
        steps: [],
        fixRounds: [],
        fixedFiles: [],
      });
      return apiSuccess({ ...report });
    }

    const fixRounds: VerifyReport['fixRounds'] = [];
    const fixed = new Map<string, string | null>();
    let result = await runProjectBuild(bookId, spec.buildCommands);

    for (let round = 1; !result.passed && result.failedStep && round <= MAX_FIX_ROUNDS; round++) {
      const failed = result.failedStep;
      log.warn(`Build failed at "${failed.command}" (round ${round}) — asking the model for a fix`);

      const current = await listProjectFiles(bookId);
      const prompts = buildPrompt(PROMPT_IDS.BOOK_FIX_BUILD, {
        spec: JSON.stringify(spec, null, 2),
        files: current.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n').slice(0, 60000),
        command: failed.command,
        exitCode: String(failed.exitCode),
        output: (failed.outputTail || '').slice(-7000),
        previousAttempts: fixRounds.length
          ? `## Previous fix attempts (did not fully work)\n${fixRounds.map((r) => `- Round ${r.round}: ${r.summary}`).join('\n')}`
          : '',
      });
      if (!prompts) break;

      const reply = await generateBookText(req, prompts.system, prompts.user, 16000, 'book-fix-build');
      const changed = extractProjectFiles(reply);
      const summary = reply.match(/SUMMARY:\s*(.+)/)?.[1]?.trim() || 'Applied fixes';
      if (changed.length === 0) {
        fixRounds.push({ round, failedCommand: failed.command, summary: 'Model returned no files', files: [] });
        break;
      }

      for (const entry of await applyVerifiedFiles(bookId, changed)) {
        if (!fixed.has(entry.path)) fixed.set(entry.path, entry.sectionId);
      }
      fixRounds.push({ round, failedCommand: failed.command, summary, files: changed.map((f) => f.path) });
      result = await runProjectBuild(bookId, spec.buildCommands);
    }

    // Write fixes back into the sections that last showed each file, so the
    // chapters (not just the appendix) contain working code.
    const fixedFiles: VerifyReport['fixedFiles'] = [];
    const finalFiles = new Map((await listProjectFiles(bookId)).map((f) => [f.path, f.content]));
    for (const [filePath, sectionId] of fixed) {
      let writtenBackTo: string | null = null;
      if (sectionId) {
        const markdown = await readSection(bookId, sectionId);
        const updated = markdown ? replaceFileBlock(markdown, filePath, finalFiles.get(filePath) ?? '') : null;
        if (updated) {
          await writeSection(bookId, sectionId, updated);
          writtenBackTo = sectionId;
        }
      }
      fixedFiles.push({ path: filePath, writtenBackTo });
    }

    const report = await save({
      status: result.passed ? 'passed' : 'failed',
      reason: result.passed ? undefined : `Still failing at: ${result.failedStep?.command ?? 'unknown step'}`,
      verifiedAt: new Date().toISOString(),
      toolchain: result.toolchain,
      notes: result.steps.filter((s) => s.note).map((s) => `${s.command}: ${s.note}`),
      steps: result.steps,
      fixRounds,
      fixedFiles,
    });

    log.info(
      `Verification ${report.status} for "${book.title}" after ${fixRounds.length} fix round(s)` +
        (fixedFiles.length ? `; fixed ${fixedFiles.map((f) => f.path).join(', ')}` : ''),
    );
    return apiSuccess({ ...report });
  } catch (error) {
    log.error('Book verification failed:', error);
    return apiError('GENERATION_FAILED', 500, error instanceof Error ? error.message : String(error));
  }
}
