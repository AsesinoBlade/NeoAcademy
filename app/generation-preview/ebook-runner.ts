/**
 * Ebook generation pipeline (runs in the generation-preview page).
 *
 *   1. Save the approved outline as data/books/<id>/book.json
 *   2. Write every missing section (one request each, resume-safe)
 *   3. Unload the LLM, start ComfyUI, generate missing pictures, stop ComfyUI
 *   4. Assemble and print the PDF
 *
 * Every step checks the AbortSignal, so Pause stops between requests and a
 * later Resume continues with the first unwritten section / missing image.
 */
import type { SceneOutline } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';

const log = createLogger('Ebook');

export interface EbookRunContext {
  bookId: string;
  outline: SceneOutline[];
  requirement: string;
  language: string;
  fallbackTitle: string;
  /** Premise check results, saved with the book for writers and reviewers. */
  premises?: import('@/lib/book/principles').PremiseFinding[];
  /** quick | beginner | advanced. */
  bookStyle?: import('@/lib/book/styles').BookStyle;
  referenceMaterial?: string;
  userProfile?: string;
  imageGenerationEnabled: boolean;
  /** Verify claims against local docs / web and run a technical review per section. */
  factCheck: boolean;
  /** Allow web search during fact-checking (local tool docs are always used). */
  webSearch: boolean;
  /**
   * Check the tools the planned project needs (cmake, make, compiler, git...).
   * Waits for the user if something is missing; throws AbortError on pause.
   */
  preflightProject?: () => Promise<void>;
  /** Called once the book has a real title (from the outline or the planner). */
  onTitle?: (title: string, subtitle?: string) => void | Promise<void>;
  signal: AbortSignal;
  /** Model + media provider headers (same as class generation). */
  apiHeaders: () => Record<string, string>;
  setStatus: (message: string) => void;
  logProgress: (message: string) => void;
}

const abortError = () => new DOMException('Generation aborted', 'AbortError');

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.details || `${url} failed (${response.status})`);
  }
  return data as T;
}

/** Split "Title — spec" the same way the server does, for status messages. */
function sectionTitle(raw: string): string {
  const text = raw.trim();
  const m = text.match(/^(.{3,140}?)\s+(?:—|–|-{1,2})\s+/) ?? text.match(/^(.{3,100}?):\s+/);
  return (m ? m[1] : text).slice(0, 90);
}

export async function runEbookGeneration(ctx: EbookRunContext): Promise<{ pdfUrl: string }> {
  const { signal } = ctx;
  const first = ctx.outline[0];

  // 1. Book record (idempotent: on resume this just refreshes the outline).
  await postJson(
    '/api/books',
    {
      id: ctx.bookId,
      title: first?.bookTitle?.trim() || ctx.fallbackTitle,
      subtitle: first?.bookSubtitle?.trim() || undefined,
      requirement: ctx.requirement,
      language: ctx.language,
      outline: ctx.outline,
      coverImagePrompt: ctx.imageGenerationEnabled ? first?.coverImagePrompt : undefined,
      premises: ctx.premises,
      bookStyle: ctx.bookStyle,
    },
    {},
    signal,
  );

  // Plan: a proper title (never the prompt) and, for hands-on books, the
  // canonical project spec every section must follow.
  ctx.setStatus('Planning the book and its running project...');
  ctx.logProgress('[Ebook] Planning title and project specification');
  const plan = await postJson<{
    title: string;
    subtitle?: string;
    hasProject: boolean;
    skipped?: boolean;
  }>('/api/generate/book-plan', { bookId: ctx.bookId }, ctx.apiHeaders(), signal);
  if (!plan.skipped) {
    ctx.logProgress(
      `[Ebook] "${plan.title}"${plan.hasProject ? ' — running project planned' : ''}`,
    );
  }
  await ctx.onTitle?.(plan.title, plan.subtitle);

  // Now that the project (and its build commands) is known, check the tools it
  // needs before any chapter is written.
  if (plan.hasProject && ctx.preflightProject) {
    ctx.setStatus("Checking the tools the book's project needs...");
    await ctx.preflightProject();
  }

  const statusResponse = await fetch(`/api/books?id=${encodeURIComponent(ctx.bookId)}`, {
    cache: 'no-store',
    signal,
  });
  const statusData = await statusResponse.json();
  const written = new Set<string>(statusData?.progress?.writtenSectionIds ?? []);
  const reviewed = new Set<string>(statusData?.progress?.reviewedSectionIds ?? []);

  // 2. Sections, in book order.
  const sectionPlan: Array<{ id: string; chapter: number; section: number; title: string }> = [];
  ctx.outline.forEach((chapter, ci) =>
    (chapter.keyPoints || [])
      .filter((p) => p.trim())
      .forEach((point, si) =>
        sectionPlan.push({
          id: `c${String(ci + 1).padStart(2, '0')}s${String(si + 1).padStart(2, '0')}`,
          chapter: ci + 1,
          section: si + 1,
          title: sectionTitle(point),
        }),
      ),
  );

  const total = sectionPlan.length;
  let done = sectionPlan.filter((p) => written.has(p.id)).length;
  if (done > 0) ctx.logProgress(`[Ebook] Resuming: ${done} of ${total} sections already written`);
  ctx.logProgress(
    `[Ebook] Writing ${total - done} section(s) across ${ctx.outline.length} chapters`,
  );

  let words = 0;
  // Chapter checkpoint: the running project must build at the end of every
  // chapter, so a mistake is fixed before later chapters build on it.
  // Already-passed checkpoints return immediately (resume-safe).
  const runCheckpoint = async (chapter: number) => {
    if (!plan.hasProject) return;
    if (signal.aborted) throw abortError();
    ctx.setStatus(`Checking that the project builds after chapter ${chapter}...`);
    try {
      const report = await postJson<{
        status: string;
        skipped?: boolean;
        reason?: string;
        fixedFiles?: Array<{ path: string }>;
      }>(
        '/api/generate/book-verify',
        { bookId: ctx.bookId, checkpointChapter: chapter },
        ctx.apiHeaders(),
        signal,
      );
      if (!report.skipped && report.status !== 'skipped') {
        ctx.logProgress(
          `[Ebook] Chapter ${chapter} build checkpoint ${report.status}` +
            (report.fixedFiles?.length
              ? ` — fixed ${report.fixedFiles.map((f) => f.path).join(', ')}`
              : '') +
            (report.status === 'failed' && report.reason ? ` (${report.reason})` : ''),
        );
      }
    } catch (error) {
      if (signal.aborted) throw abortError();
      ctx.logProgress(
        `[Ebook] Chapter ${chapter} build checkpoint could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  for (const [index, item] of sectionPlan.entries()) {
    const endsChapter =
      index === sectionPlan.length - 1 || sectionPlan[index + 1].chapter !== item.chapter;
    const needsWriting = !written.has(item.id);
    const needsReview = ctx.factCheck && !reviewed.has(item.id);
    if (!needsWriting && !needsReview) {
      if (endsChapter) await runCheckpoint(item.chapter);
      continue;
    }
    if (signal.aborted) throw abortError();
    const label = `${item.chapter}.${item.section} ${item.title}`;

    if (needsWriting) {
      ctx.setStatus(`Writing section ${done + 1} of ${total} — ${label}`);
      ctx.logProgress(`[Ebook] Writing section ${done + 1} of ${total}: ${label}`);

      const body = {
        bookId: ctx.bookId,
        sectionId: item.id,
        referenceMaterial: ctx.referenceMaterial,
        userProfile: ctx.userProfile,
        factCheck: ctx.factCheck,
        webSearch: ctx.webSearch,
      };

      let result: { words?: number };
      try {
        result = await postJson('/api/generate/book-section', body, ctx.apiHeaders(), signal);
      } catch (error) {
        if (signal.aborted) throw abortError();
        log.warn(`Section ${item.id} failed, retrying once:`, error);
        result = await postJson('/api/generate/book-section', body, ctx.apiHeaders(), signal);
      }

      done++;
      words += result.words ?? 0;
      ctx.logProgress(`[Ebook] Completed section ${done} of ${total} (${result.words ?? 0} words)`);
    }

    // Fact-check + technical review (separate request, so pause/resume works
    // between writing and reviewing).
    if (needsReview) {
      if (signal.aborted) throw abortError();
      ctx.setStatus(`Fact-checking ${label}`);
      const reviewBody = { bookId: ctx.bookId, sectionId: item.id, webSearch: ctx.webSearch };
      let review: {
        claims?: number;
        notFound?: number;
        corrections?: number;
        accepted?: boolean;
        mathChecked?: number;
        mathWrong?: number;
        mathWrongAfter?: number | null;
      };
      try {
        review = await postJson('/api/generate/book-review', reviewBody, ctx.apiHeaders(), signal);
      } catch (error) {
        if (signal.aborted) throw abortError();
        log.warn(`Review of ${item.id} failed, retrying once:`, error);
        review = await postJson('/api/generate/book-review', reviewBody, ctx.apiHeaders(), signal);
      }
      if (review.corrections || review.mathWrong) {
        ctx.logProgress(
          `[Ebook] Reviewed ${label}: ${review.claims ?? 0} claims checked, ${review.notFound ?? 0} not found, ` +
            `${review.mathChecked ?? 0} calculations checked (${review.mathWrong ?? 0} wrong` +
            `${review.mathWrongAfter != null ? ` → ${review.mathWrongAfter} after review` : ''}), ` +
            `${review.corrections ?? 0} correction(s)${review.accepted ? ' applied' : ' (kept original)'}`,
        );
      }

    }

    if (endsChapter) await runCheckpoint(item.chapter);
  }
  if (words > 0)
    ctx.logProgress(`[Ebook] Writing complete (+${words.toLocaleString()} words this run)`);

  // Build verification: compile/test the appendix project and fix it (needs
  // the LLM, so it runs before the model is unloaded).
  if (plan.hasProject) {
    if (signal.aborted) throw abortError();
    ctx.setStatus('Verifying that the project builds...');
    ctx.logProgress('[Ebook] Building and testing the project');
    try {
      const report = await postJson<{
        status: string;
        reason?: string;
        skipped?: boolean;
        fixRounds?: unknown[];
        fixedFiles?: Array<{ path: string }>;
      }>('/api/generate/book-verify', { bookId: ctx.bookId }, ctx.apiHeaders(), signal);
      if (!report.skipped) {
        ctx.logProgress(
          `[Ebook] Build verification ${report.status}` +
            (report.fixedFiles?.length
              ? ` — fixed ${report.fixedFiles.map((f) => f.path).join(', ')}`
              : '') +
            (report.reason ? ` (${report.reason})` : ''),
        );
      }
    } catch (error) {
      if (signal.aborted) throw abortError();
      // Verification is advisory: never fail the book because of it.
      ctx.logProgress(
        `[Ebook] Build verification could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 3. Pictures — separate phase so the LLM and ComfyUI never share VRAM.
  // Release the LLM before ComfyUI starts: both cannot share the GPU. The
  // ComfyUI start itself also refuses while a model is still resident.
  const unload = await fetch('/api/unload-local-llm', { method: 'POST', signal })
    .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
    .catch((error) => {
      if (signal.aborted) throw abortError();
      return { ok: false, data: { message: String(error) } };
    });
  if (!unload.ok) {
    ctx.logProgress(
      `[Ebook] LLM unload reported a problem (${unload.data?.message ?? 'unknown'}); ` +
        'ComfyUI will only start once the GPU is free.',
    );
  }

  if (ctx.imageGenerationEnabled) {
    if (signal.aborted) throw abortError();
    const probe = await postJson<{ remaining: number }>(
      '/api/generate/book-image',
      { bookId: ctx.bookId, dryRun: true },
      {},
      signal,
    ).catch(() => ({ remaining: 1 }));

    if (probe.remaining > 0) {
      ctx.setStatus('Starting the image generator...');
      ctx.logProgress('[Ebook] Starting ComfyUI for illustrations');
      await postJson('/api/local-comfyui', { action: 'start' }, {}, signal);

      try {
        let generated = 0;
        for (;;) {
          if (signal.aborted) throw abortError();
          const step = await postJson<{ remaining: number; generated?: string; failed?: string }>(
            '/api/generate/book-image',
            { bookId: ctx.bookId },
            ctx.apiHeaders(),
            signal,
          );
          if (step.generated) generated++;
          if (step.failed)
            ctx.logProgress(`[Ebook] Picture ${step.failed} failed; will retry once`);
          if (step.remaining === 0) break;
          ctx.setStatus(`Generating pictures — ${generated} done, ${step.remaining} to go`);
        }
        ctx.logProgress(`[Ebook] Pictures complete (${generated} generated)`);
      } finally {
        await fetch('/api/local-comfyui', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop' }),
        }).catch(() => undefined);
      }
    }
  }

  // 4. PDF
  if (signal.aborted) throw abortError();
  ctx.setStatus('Typesetting the book and printing the PDF...');
  ctx.logProgress('[Ebook] Rendering PDF');
  const pdf = await postJson<{ url: string; bytes: number; missingSections: number }>(
    '/api/generate/book-pdf',
    { bookId: ctx.bookId },
    {},
    signal,
  );
  ctx.logProgress(
    `[Ebook] PDF ready (${(pdf.bytes / 1024 / 1024).toFixed(1)} MB)` +
      (pdf.missingSections ? `, ${pdf.missingSections} section(s) missing` : ''),
  );
  return { pdfUrl: pdf.url };
}
