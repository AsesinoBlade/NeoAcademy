'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, BookOpen, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

interface BookStatus {
  book: { id: string; title: string; subtitle?: string; outline: unknown[] };
  progress: {
    totalSections: number;
    writtenSections: number;
    words: number;
    imagesTotal: number;
    imagesDone: number;
    pdf: { bytes: number; updatedAt: string } | null;
  };
}

export default function BookPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [status, setStatus] = useState<BookStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [pdfVersion, setPdfVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/books?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Book not found');
      setStatus(data as BookStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const rebuild = async () => {
    setRebuilding(true);
    try {
      const response = await fetch('/api/generate/book-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: id }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'PDF rendering failed');
      toast.success('PDF rebuilt');
      setPdfVersion((v) => v + 1);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRebuilding(false);
    }
  };

  const pdfUrl = `/api/books/${encodeURIComponent(id)}/pdf`;
  const p = status?.progress;

  return (
    <div className="h-screen flex flex-col bg-slate-50 dark:bg-slate-950">
      <header className="border-b bg-white/80 dark:bg-slate-900/80 backdrop-blur">
        <div className="mx-auto w-full max-w-6xl px-4 py-3 flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.push('/')}>
            <ArrowLeft className="size-4 mr-1.5" />
            Home
          </Button>
          <BookOpen className="size-5 text-blue-600" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{status?.book.title ?? 'Ebook'}</h1>
            {p && (
              <p className="text-xs text-muted-foreground">
                {status?.book.outline.length} chapters · {p.writtenSections}/{p.totalSections} sections ·{' '}
                {p.words.toLocaleString()} words (~{Math.round(p.words / 420)} pages of text)
                {p.imagesTotal > 0 && ` · ${p.imagesDone}/${p.imagesTotal} pictures`}
                {p.pdf && ` · PDF ${(p.pdf.bytes / 1024 / 1024).toFixed(1)} MB`}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={rebuild} disabled={rebuilding || !p}>
              {rebuilding ? (
                <Loader2 className="size-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5 mr-1.5" />
              )}
              Rebuild PDF
            </Button>
            <Button variant="outline" size="sm" asChild disabled={!p?.pdf}>
              <a href={pdfUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5 mr-1.5" />
                Open
              </a>
            </Button>
            <Button size="sm" asChild disabled={!p?.pdf}>
              <a href={`${pdfUrl}?download=1`}>
                <Download className="size-3.5 mr-1.5" />
                Download
              </a>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0">
        {error ? (
          <div className="h-full flex items-center justify-center text-destructive">{error}</div>
        ) : !status ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
          </div>
        ) : p?.pdf ? (
          <iframe
            key={pdfVersion}
            title={status.book.title}
            src={`${pdfUrl}?v=${pdfVersion}`}
            className="h-full w-full border-0"
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <p>No PDF has been rendered for this book yet.</p>
            <Button onClick={rebuild} disabled={rebuilding}>
              {rebuilding && <Loader2 className="size-4 mr-1.5 animate-spin" />}
              Render PDF
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
