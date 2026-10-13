/**
 * GET /api/books/<id>/pdf            → view the book PDF inline
 * GET /api/books/<id>/pdf?download=1 → download it
 */
import { type NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';

import { bookPdfPath, readBook } from '@/lib/book/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const book = await readBook(id);
    const pdf = await fs.readFile(bookPdfPath(id));
    const fileName = `${(book?.title || 'book').replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'book'}.pdf`;
    const disposition = request.nextUrl.searchParams.get('download') ? 'attachment' : 'inline';
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${disposition}; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new Response('PDF not found', { status: 404 });
  }
}
