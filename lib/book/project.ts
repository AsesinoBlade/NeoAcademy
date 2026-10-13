/**
 * The book's running project ("project ledger").
 *
 * Programming books build one project across many sections, but each section
 * is written by a separate model call. Without shared state every section
 * reinvents target names, paths and file contents. The ledger fixes that:
 *
 *  - ProjectSpec: canonical names, file tree, targets, build commands —
 *    decided once after the outline is approved (book-plan route).
 *  - Project files: every code block whose first line is `// File: <path>`
 *    (complete file content) is saved to data/books/<id>/project/<path>,
 *    so later sections and the appendix see the real current state.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { bookDir } from './storage';

export interface ProjectSpec {
  name: string;
  summary: string;
  language: string;
  /** e.g. "CMake 3.20+ generating Unix Makefiles" */
  buildSystem: string;
  /** Exact commands the reader runs to build/test/run, in order. */
  buildCommands: string[];
  files: Array<{ path: string; purpose: string; introducedInChapter?: number }>;
  /** Build targets / modules with their exact names. */
  components: Array<{ name: string; kind: string; dependsOn?: string[]; description?: string }>;
  /** Naming rules: namespaces, include paths, prefixes. */
  conventions: string[];
}

export const projectDir = (bookId: string) => path.join(bookDir(bookId), 'project');
const indexPath = (bookId: string) => path.join(projectDir(bookId), '.index.json');

interface ProjectIndex {
  [filePath: string]: { sectionId: string; updatedAt: string; lines: number };
}

/** Normalise and validate a project-relative path (no absolute paths, no ..). */
export function safeProjectPath(raw: string): string | null {
  const cleaned = raw.trim().replace(/^[`'"]+|[`'":,]+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!cleaned || cleaned.startsWith('/') || /^[a-z]:/i.test(cleaned)) return null;
  const normalised = path.posix.normalize(cleaned);
  if (normalised.startsWith('..') || normalised.includes('/../') || normalised.length > 200) return null;
  if (!/^[\w@+\-./ ]+$/.test(normalised)) return null;
  return normalised;
}

const FILE_HEADER_RE = /^\s*(?:\/\/|#|--|;|%|<!--|\/\*)\s*File:\s*([^\s*>]+)/i;

/** Complete project files declared in a section's code blocks. */
export function extractProjectFiles(markdown: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const fenceRe = /^([ \t]*)```[^\n]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm;
  for (const match of markdown.matchAll(fenceRe)) {
    const indent = match[1];
    const body = indent
      ? match[2]
          .split('\n')
          .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
          .join('\n')
      : match[2];
    const firstLine = body.split('\n', 1)[0] ?? '';
    const header = firstLine.match(FILE_HEADER_RE);
    if (!header) continue;
    const filePath = safeProjectPath(header[1]);
    if (!filePath) continue;
    files.push({ path: filePath, content: body.endsWith('\n') ? body : `${body}\n` });
  }
  return files;
}

async function readIndex(bookId: string): Promise<ProjectIndex> {
  try {
    return JSON.parse(await fs.readFile(indexPath(bookId), 'utf-8')) as ProjectIndex;
  } catch {
    return {};
  }
}

/** Save the complete files a section declared (later sections overwrite). */
export async function recordProjectFiles(
  bookId: string,
  sectionId: string,
  files: Array<{ path: string; content: string }>,
): Promise<number> {
  if (files.length === 0) return 0;
  const index = await readIndex(bookId);
  for (const file of files) {
    const target = path.join(projectDir(bookId), file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf-8');
    index[file.path] = {
      sectionId,
      updatedAt: new Date().toISOString(),
      lines: file.content.split('\n').length,
    };
  }
  await fs.mkdir(projectDir(bookId), { recursive: true });
  await fs.writeFile(indexPath(bookId), JSON.stringify(index, null, 2), 'utf-8');
  return files.length;
}

export async function listProjectFiles(
  bookId: string,
): Promise<Array<{ path: string; sectionId: string; lines: number; content: string }>> {
  const index = await readIndex(bookId);
  const out: Array<{ path: string; sectionId: string; lines: number; content: string }> = [];
  for (const [filePath, meta] of Object.entries(index)) {
    try {
      const content = await fs.readFile(path.join(projectDir(bookId), filePath), 'utf-8');
      out.push({ path: filePath, sectionId: meta.sectionId, lines: meta.lines, content });
    } catch {
      /* file removed */
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Project context for a section prompt: the spec plus the current content of
 * the files most relevant to this section (within a character budget), and a
 * listing of the rest.
 */
export async function buildProjectContext(
  bookId: string,
  spec: ProjectSpec,
  relevanceText: string,
  budgetChars: number,
): Promise<string> {
  const files = await listProjectFiles(bookId);
  const relevance = relevanceText.toLowerCase();

  const scored = files
    .map((f) => {
      const base = path.posix.basename(f.path).toLowerCase();
      const mentioned = relevance.includes(f.path.toLowerCase()) || relevance.includes(base);
      return { ...f, score: (mentioned ? 2 : 0) + (f.path.toLowerCase().includes('cmakelists') ? 1 : 0) };
    })
    .sort((a, b) => b.score - a.score);

  const included: string[] = [];
  const listed: string[] = [];
  let used = 0;
  for (const f of scored) {
    const block = `--- ${f.path} (current version, last changed in section ${f.sectionId}) ---\n${f.content}`;
    if (used + block.length <= budgetChars) {
      included.push(block);
      used += block.length;
    } else {
      listed.push(`- ${f.path} (${f.lines} lines, last changed in section ${f.sectionId})`);
    }
  }

  return [
    '### Project specification (canonical — use these exact names, paths and commands)',
    '```json',
    JSON.stringify(spec, null, 2),
    '```',
    files.length === 0
      ? '### Project files so far\n(none yet — this section may be the first to create files)'
      : `### Current project files (exact content as the reader has it now)\n${included.join('\n\n')}` +
        (listed.length ? `\n\nOther existing files (content omitted for length):\n${listed.join('\n')}` : ''),
  ].join('\n\n');
}

/**
 * Apply files corrected by build verification. The index keeps the section
 * that last showed each file (so the fix can be written back into that
 * section); brand-new files are attributed to "verify".
 */
export async function applyVerifiedFiles(
  bookId: string,
  files: Array<{ path: string; content: string }>,
): Promise<Array<{ path: string; sectionId: string | null }>> {
  const index = await readIndex(bookId);
  const applied: Array<{ path: string; sectionId: string | null }> = [];
  for (const file of files) {
    const target = path.join(projectDir(bookId), file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf-8');
    const previous = index[file.path];
    index[file.path] = {
      sectionId: previous?.sectionId ?? 'verify',
      updatedAt: new Date().toISOString(),
      lines: file.content.split('\n').length,
    };
    applied.push({ path: file.path, sectionId: previous && previous.sectionId !== 'verify' ? previous.sectionId : null });
  }
  await fs.mkdir(projectDir(bookId), { recursive: true });
  await fs.writeFile(indexPath(bookId), JSON.stringify(index, null, 2), 'utf-8');
  return applied;
}
