/**
 * Ebook records.
 *
 * POST /api/books  { id, title, subtitle?, requirement, language, outline, coverImagePrompt? }
 *   Create or update the book (outline approved / revised).
 * GET  /api/books?id=...
 *   Book record plus progress: written sections, words, images, PDF status.
 */
import { type NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  bookDir,
  bookPdfPath,
  countWords,
  fileExists,
  imagesDir,
  listSectionRefs,
  listWrittenSectionIds,
  readBook,
  readSection,
  writeBook,
} from '@/lib/book/storage';
import { extractImageSpecs } from '@/lib/book/figures';
import type { SceneOutline } from '@/lib/types/generation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      id: string;
      title: string;
      subtitle?: string;
      requirement: string;
      language?: string;
      outline: SceneOutline[];
      coverImagePrompt?: string;
    };
    if (!body.id || !body.title || !Array.isArray(body.outline) || body.outline.length === 0) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'id, title and outline are required');
    }
    const record = await writeBook({
      id: body.id,
      title: body.title,
      subtitle: body.subtitle,
      requirement: body.requirement || '',
      language: body.language || 'en-US',
      outline: body.outline,
      coverImagePrompt: body.coverImagePrompt,
    });
    return apiSuccess({ book: record });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing id');

    const book = await readBook(id);
    if (!book) return apiError('INVALID_REQUEST', 404, 'Book not found');

    const refs = listSectionRefs(book.outline);
    const written = await listWrittenSectionIds(id);

    let words = 0;
    let imagesTotal = 0;
    let imagesDone = 0;
    for (const ref of refs) {
      if (!written.has(ref.id)) continue;
      const markdown = (await readSection(id, ref.id)) ?? '';
      words += countWords(markdown);
      for (const spec of extractImageSpecs(markdown)) {
        imagesTotal++;
        if (await fileExists(path.join(imagesDir(id), `${spec.id}.png`))) imagesDone++;
      }
    }

    const pdfStat = await fs.stat(bookPdfPath(id)).catch(() => null);
    const reviewedSectionIds = await fs
      .readdir(path.join(bookDir(id), 'reviews'))
      .then((files) => files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)))
      .catch(() => [] as string[]);

    return apiSuccess({
      book,
      progress: {
        totalSections: refs.length,
        writtenSections: refs.filter((r) => written.has(r.id)).length,
        writtenSectionIds: refs.filter((r) => written.has(r.id)).map((r) => r.id),
        reviewedSectionIds,
        words,
        imagesTotal,
        imagesDone,
        pdf: pdfStat ? { bytes: pdfStat.size, updatedAt: pdfStat.mtime.toISOString() } : null,
      },
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
