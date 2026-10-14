/**
 * Durable ebook storage: data/books/<id>/
 *
 *   book.json            outline + metadata
 *   sections/c01s01.md   one Markdown file per written section
 *   images/<figId>.png   generated illustrations (+ failed.json)
 *   book.html / book.pdf the assembled book
 *
 * Sections are written one at a time, so a paused or interrupted book
 * resumes from the first section that has no file yet.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SceneOutline } from '@/lib/types/generation';
import { isValidClassroomId, writeJsonFileAtomic } from '@/lib/server/classroom-storage';

export const BOOKS_DIR = path.join(process.cwd(), 'data', 'books');

export interface BookRecord {
  id: string;
  title: string;
  subtitle?: string;
  requirement: string;
  language: string;
  /** Chapters (type 'chapter'); keyPoints = section specs in order. */
  outline: SceneOutline[];
  coverImagePrompt?: string;
  /**
   * The running project ("ledger"). undefined = not planned yet,
   * null = planned, and this book has no hands-on project.
   */
  projectSpec?: import('./project').ProjectSpec | null;
  /** Verify claims against local docs / web and run a technical review per section. */
  factCheck?: boolean;
  /** Premise check of the request: verdicts + how the book treats each premise. */
  premises?: import('./principles').PremiseFinding[];
  createdAt: string;
  updatedAt: string;
}

export interface SectionRef {
  id: string;
  chapterIndex: number;
  sectionIndex: number;
  chapterNumber: number;
  sectionNumber: string;
  title: string;
  spec: string;
}

export function assertValidBookId(id: string): void {
  if (!isValidClassroomId(id)) throw new Error(`Invalid book id: ${id}`);
}

export const bookDir = (id: string) => path.join(BOOKS_DIR, id);
export const sectionsDir = (id: string) => path.join(bookDir(id), 'sections');
export const imagesDir = (id: string) => path.join(bookDir(id), 'images');
export const bookJsonPath = (id: string) => path.join(bookDir(id), 'book.json');
export const bookHtmlPath = (id: string) => path.join(bookDir(id), 'book.html');
export const bookPdfPath = (id: string) => path.join(bookDir(id), 'book.pdf');

const pad2 = (n: number) => String(n).padStart(2, '0');

export function sectionFileId(chapterIndex: number, sectionIndex: number): string {
  return `c${pad2(chapterIndex + 1)}s${pad2(sectionIndex + 1)}`;
}

/**
 * Section specs are written as "Title — what it covers". Split on the first
 * em/en dash (or " - " / ": ") so the title becomes the heading and the rest
 * becomes the writing brief.
 */
export function parseSectionSpec(raw: string): { title: string; spec: string } {
  const text = raw.trim().replace(/^\d+(\.\d+)*[.)]?\s+/, '');
  const match =
    text.match(/^(.{3,140}?)\s+(?:—|–|-{1,2})\s+([\s\S]+)$/) ?? text.match(/^(.{3,100}?):\s+([\s\S]+)$/);
  if (match) return { title: match[1].trim(), spec: match[2].trim() };
  return { title: text.length > 120 ? `${text.slice(0, 117)}...` : text, spec: text };
}

export function listSectionRefs(outline: SceneOutline[]): SectionRef[] {
  const refs: SectionRef[] = [];
  outline.forEach((chapter, chapterIndex) => {
    (chapter.keyPoints || [])
      .filter((point) => point.trim())
      .forEach((point, sectionIndex) => {
        const { title, spec } = parseSectionSpec(point);
        refs.push({
          id: sectionFileId(chapterIndex, sectionIndex),
          chapterIndex,
          sectionIndex,
          chapterNumber: chapterIndex + 1,
          sectionNumber: `${chapterIndex + 1}.${sectionIndex + 1}`,
          title,
          spec,
        });
      });
  });
  return refs;
}

export async function readBook(id: string): Promise<BookRecord | null> {
  assertValidBookId(id);
  try {
    return JSON.parse(await fs.readFile(bookJsonPath(id), 'utf-8')) as BookRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeBook(
  data: Omit<BookRecord, 'createdAt' | 'updatedAt'>,
): Promise<BookRecord> {
  assertValidBookId(data.id);
  const existing = await readBook(data.id);
  const now = new Date().toISOString();
  const record: BookRecord = {
    ...existing,
    ...data,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await fs.mkdir(sectionsDir(data.id), { recursive: true });
  await fs.mkdir(imagesDir(data.id), { recursive: true });
  await writeJsonFileAtomic(bookJsonPath(data.id), record);
  return record;
}

export async function readSection(id: string, sectionId: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(sectionsDir(id), `${sectionId}.md`), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeSection(id: string, sectionId: string, markdown: string) {
  await fs.mkdir(sectionsDir(id), { recursive: true });
  const target = path.join(sectionsDir(id), `${sectionId}.md`);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, markdown, 'utf-8');
  await fs.rename(temp, target);
}

export async function listWrittenSectionIds(id: string): Promise<Set<string>> {
  try {
    const files = await fs.readdir(sectionsDir(id));
    return new Set(files.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));
  } catch {
    return new Set();
  }
}

export function countWords(markdown: string): number {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
