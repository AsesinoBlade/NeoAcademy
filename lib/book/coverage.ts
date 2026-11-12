/**
 * Verification coverage of a book, aggregated from its section reviews:
 * how each claim was settled, code samples compiled, calculations checked,
 * and the claims that remain unverified or disputed.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { bookDir } from './storage';

export interface BookCoverage {
  sectionsReviewed: number;
  claims: number;
  byDocs: number;
  byWeb: number;
  byCrossCheck: number;
  corrected: number;
  /** Contradicted (by documentation or a judge) and still in the final text. */
  disputed: number;
  /** An independent answer differed without a ruling; still in the text. */
  uncertain: number;
  unverified: number;
  codeSamples: number;
  codeErrorsLeft: number;
  calculations: number;
  calculationsWrongLeft: number;
  /** Claims a reader should double-check, by section. */
  openClaims: Array<{ section: string; title: string; identifier: string; statement: string; status: 'disputed' | 'not-found' | 'uncertain' | 'unverified'; note?: string }>;
}

interface ReviewFile {
  sectionNumber: string;
  title: string;
  accepted?: boolean;
  evidence?: Array<{
    identifier: string;
    statement: string;
    verdict: string;
    source: string;
    independentAnswer?: string;
    contested?: boolean;
    /** What the final text says: still claimed, changed, or removed (absent in older reviews). */
    afterReview?: 'still' | 'changed' | 'removed';
  }>;
  code?: { checked: number; withErrorsAfter: number | null };
  math?: { checked?: number; wrongAfter?: number | null; available?: boolean };
}

export async function computeCoverage(bookId: string): Promise<BookCoverage | null> {
  const dir = path.join(bookDir(bookId), 'reviews');
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  if (!files.length) return null;
  const cov: BookCoverage = {
    sectionsReviewed: 0, claims: 0, byDocs: 0, byWeb: 0, byCrossCheck: 0, corrected: 0, disputed: 0, uncertain: 0, unverified: 0,
    codeSamples: 0, codeErrorsLeft: 0, calculations: 0, calculationsWrongLeft: 0, openClaims: [],
  };
  const reviews: ReviewFile[] = [];
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    try {
      reviews.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8')) as ReviewFile);
    } catch {
      /* skip */
    }
  }
  reviews.sort((a, b) => a.sectionNumber.localeCompare(b.sectionNumber, undefined, { numeric: true }));
  for (const r of reviews) {
    cov.sectionsReviewed++;
    for (const e of r.evidence ?? []) {
      cov.claims++;
      // Older reviews have no afterReview: then "not found" was assumed corrected.
      const stillInText = e.afterReview ? e.afterReview === 'still' : e.verdict !== 'not-found';
      const open = (status: BookCoverage['openClaims'][number]['status'], note?: string) =>
        cov.openClaims.push({ section: r.sectionNumber, title: r.title, identifier: e.identifier, statement: e.statement, status, note });
      if (e.verdict === 'confirmed') {
        if (e.source === 'cross-check') cov.byCrossCheck++;
        else if (e.source === 'web') cov.byWeb++;
        else cov.byDocs++;
      } else if (e.verdict === 'not-found' || e.verdict === 'disputed') {
        if (!stillInText) {
          cov.corrected++;
        } else {
          cov.disputed++;
          open(e.verdict === 'not-found' ? 'not-found' : 'disputed', e.independentAnswer);
        }
      } else if (e.contested) {
        if (stillInText) {
          cov.uncertain++;
          open('uncertain', e.independentAnswer);
        } else {
          cov.unverified++;
        }
      } else {
        cov.unverified++;
        if (stillInText) open('unverified');
      }
    }
    cov.codeSamples += r.code?.checked ?? 0;
    cov.codeErrorsLeft += r.code?.withErrorsAfter ?? 0;
    cov.calculations += r.math?.checked ?? 0;
    cov.calculationsWrongLeft += r.math?.wrongAfter ?? 0;
  }
  return cov;
}
