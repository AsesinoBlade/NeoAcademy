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
  referenceMaterial?: string;
  userProfile?: string;
  imageGenerationEnabled: boolean;
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
    },
    {},
    signal,
  );

  const statusResponse = await fetch(`/api/books?id=${encodeURIComponent(ctx.bookId)}`, {
    cache: 'no-store',
    signal,
  });
  const statusData = await statusResponse.json();
  const written = new Set<string>(statusData?.progress?.writtenSectionIds ?? []);

  // 2. Sections, in book order.
  const plan: Array<{ id: string; chapter: number; section: number; title: string }> = [];
  ctx.outline.forEach((chapter, ci) =>
    (chapter.keyPoints || [])
      .filter((p) => p.trim())
      .forEach((point, si) =>
        plan.push({
          id: `c${String(ci + 1).padStart(2, '0')}s${String(si + 1).padStart(2, '0')}`,
          chapter: ci + 1,
          section: si + 1,
          title: sectionTitle(point),
        }),
      ),
  );

  const total = plan.length;
  let done = plan.filter((p) => written.has(p.id)).length;
  if (done > 0) ctx.logProgress(`[Ebook] Resuming: ${done} of ${total} sections already written`);
  ctx.logProgress(`[Ebook] Writing ${total - done} section(s) across ${ctx.outline.length} chapters`);

  let words = 0;
  for (const item of plan) {
    if (written.has(item.id)) continue;
    if (signal.aborted) throw abortError();

    const label = `${item.chapter}.${item.section} ${item.title}`;
    ctx.setStatus(`Writing section ${done + 1} of ${total} — ${label}`);
    ctx.logProgress(`[Ebook] Writing section ${done + 1} of ${total}: ${label}`);

    const body = {
      bookId: ctx.bookId,
      sectionId: item.id,
      referenceMaterial: ctx.referenceMaterial,
      userProfile: ctx.userProfile,
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
  if (words > 0) ctx.logProgress(`[Ebook] Writing complete (+${words.toLocaleString()} words this run)`);

  // 3. Pictures — separate phase so the LLM and ComfyUI never share VRAM.
  await fetch('/api/unload-local-llm', { method: 'POST' }).catch(() => undefined);

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
          if (step.failed) ctx.logProgress(`[Ebook] Picture ${step.failed} failed; will retry once`);
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
