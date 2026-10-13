/**
 * Assemble the ebook and print it to PDF.
 *
 * POST /api/generate/book-pdf  { bookId }
 * → { url, bytes, missingSections, missingImages }
 */
import { type NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';

import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { renderBookHtml } from '@/lib/book/render-html';
import { printHtmlToPdf } from '@/lib/book/pdf';
import { bookHtmlPath, bookPdfPath, readBook } from '@/lib/book/storage';

const log = createLogger('Book PDF API');

export const runtime = 'nodejs';
export const maxDuration = 900;

export async function POST(request: NextRequest) {
  try {
    const { bookId } = (await request.json()) as { bookId: string };
    if (!bookId) return apiError('MISSING_REQUIRED_FIELD', 400, 'bookId is required');

    const book = await readBook(bookId);
    if (!book) return apiError('INVALID_REQUEST', 404, 'Book not found');

    const started = Date.now();
    const rendered = await renderBookHtml(book);
    await fs.writeFile(bookHtmlPath(bookId), rendered.html, 'utf-8');

    const pdf = await printHtmlToPdf({
      htmlPath: bookHtmlPath(bookId),
      pdfPath: bookPdfPath(bookId),
      title: book.title,
    });

    log.info(
      `Rendered "${book.title}" to PDF (${(pdf.bytes / 1024 / 1024).toFixed(1)} MB via ${pdf.browser}) ` +
        `in ${Math.round((Date.now() - started) / 1000)}s` +
        (rendered.missingSections ? `, ${rendered.missingSections} section(s) missing` : '') +
        (rendered.missingImages ? `, ${rendered.missingImages} image(s) missing` : ''),
    );

    return apiSuccess({
      url: `/api/books/${encodeURIComponent(bookId)}/pdf`,
      bytes: pdf.bytes,
      missingSections: rendered.missingSections,
      missingImages: rendered.missingImages,
    });
  } catch (error) {
    log.error('Book PDF rendering failed:', error);
    return apiError('GENERATION_FAILED', 500, error instanceof Error ? error.message : String(error));
  }
}
