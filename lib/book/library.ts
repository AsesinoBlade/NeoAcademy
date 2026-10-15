/**
 * Reference libraries: documentation on this PC that a book is checked against.
 *
 * A library is a folder or a .zip (e.g. Ghidra's docs/GhidraAPI_javadoc.zip,
 * node_modules/typescript/lib, a downloaded handbook) labelled with the tool
 * it documents. Its text is extracted once, indexed by token, and cached.
 *
 * Verdict rules (the same as for CMake's built-in docs):
 *  - found → confirmed, with an excerpt the reviewer can read;
 *  - "not found" ONLY when the claim is about this library's tool and the name
 *    appears nowhere in its documentation;
 *  - Qualified names (Class.method, ns::fn): the member must appear, and the
 *    qualifier must appear in the same document.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createLogger } from '@/lib/logger';
import type { Claim, Evidence } from './references';

const log = createLogger('ReferenceLibrary');

export interface ReferenceLibrary {
  /** The tool/topic it documents, lower case: "ghidra", "typescript"... */
  tool: string;
  /** Folder or .zip on this PC. */
  path: string;
  /**
   * Complete documentation of the tool (a name missing from it does not exist).
   * Automatically assembled libraries (partial crawls, help output) are not:
   * they can confirm names, never rule them out.
   */
  complete?: boolean;
}

interface IndexedDoc {
  file: string;
  text: string;
}

interface LibraryIndex {
  docs: IndexedDoc[];
  /** token → indexes of documents containing it */
  tokens: Map<string, number[]>;
  files: number;
  bytes: number;
}

const TEXT_EXT = new Set(['.html', '.htm', '.md', '.markdown', '.txt', '.rst', '.ts', '.d.ts', '.java', '.py', '.pyi', '.json', '.xml', '.adoc', '.h', '.hpp', '.cs', '.go', '.rs']);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const INDEX_DIR = path.join(process.cwd(), 'data', 'reference-index');

const indexes = new Map<string, Promise<LibraryIndex | null>>();

function extOf(file: string): string {
  return file.toLowerCase().endsWith('.d.ts') ? '.d.ts' : path.extname(file).toLowerCase();
}

function toText(file: string, raw: string): string {
  const ext = extOf(file);
  if (ext === '.html' || ext === '.htm' || ext === '.xml') {
    return raw
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&#x27;/g, "'")
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n');
  }
  return raw;
}

/** Identifier-like tokens, including dotted / :: qualified forms and their parts. */
function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*/g)) {
    const t = m[0];
    if (t.length < 2) continue;
    out.add(t);
    if (t.includes('.') || t.includes('::')) for (const part of t.split(/\.|::/)) if (part.length >= 2) out.add(part);
  }
  for (const m of text.matchAll(/--?[A-Za-z][\w-]*/g)) out.add(m[0]); // CLI options
  return out;
}

async function collectDocs(root: string): Promise<IndexedDoc[]> {
  const docs: IndexedDoc[] = [];
  let total = 0;
  const add = (file: string, raw: string) => {
    if (total > MAX_TOTAL_BYTES || raw.length > MAX_FILE_BYTES) return;
    total += raw.length;
    docs.push({ file, text: toText(file, raw) });
  };

  const stat = await fs.stat(root);
  if (stat.isFile() && root.toLowerCase().endsWith('.zip')) {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await fs.readFile(root));
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || !TEXT_EXT.has(extOf(entry.name))) continue;
      add(entry.name, await entry.async('string'));
    }
    return docs;
  }
  if (stat.isFile()) {
    if (TEXT_EXT.has(extOf(root))) add(path.basename(root), await fs.readFile(root, 'utf-8'));
    return docs;
  }

  const walk = async (dir: string) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (total > MAX_TOTAL_BYTES) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!/^(\.git|node_modules\/\.cache)$/.test(e.name)) await walk(p);
      } else if (e.name.toLowerCase().endsWith('.zip')) {
        docs.push(...(await collectDocs(p)));
      } else if (TEXT_EXT.has(extOf(e.name))) {
        add(path.relative(root, p), await fs.readFile(p, 'utf-8').catch(() => ''));
      }
    }
  };
  await walk(root);
  return docs;
}

async function buildIndex(lib: ReferenceLibrary): Promise<LibraryIndex | null> {
  try {
    const stat = await fs.stat(lib.path);
    const key = createHash('sha1').update(`${path.resolve(lib.path)}|${stat.mtimeMs}|${stat.size}`).digest('hex');
    const cacheFile = path.join(INDEX_DIR, `${key}.json`);
    let docs: IndexedDoc[];
    try {
      docs = JSON.parse(await fs.readFile(cacheFile, 'utf-8')) as IndexedDoc[];
    } catch {
      const started = Date.now();
      docs = await collectDocs(lib.path);
      await fs.mkdir(INDEX_DIR, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(docs), 'utf-8').catch(() => undefined);
      log.info(`Indexed ${lib.tool} reference library (${docs.length} files) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    const tokens = new Map<string, number[]>();
    docs.forEach((doc, i) => {
      for (const t of tokensOf(doc.text)) {
        const list = tokens.get(t);
        if (list) {
          if (list[list.length - 1] !== i) list.push(i);
        } else tokens.set(t, [i]);
      }
    });
    return { docs, tokens, files: docs.length, bytes: docs.reduce((n, d) => n + d.text.length, 0) };
  } catch (error) {
    log.warn(`Reference library ${lib.path} could not be indexed:`, error);
    return null;
  }
}

export function getLibraryIndex(lib: ReferenceLibrary): Promise<LibraryIndex | null> {
  const key = path.resolve(lib.path);
  if (!indexes.has(key)) indexes.set(key, buildIndex(lib));
  return indexes.get(key)!;
}

/** For the preflight: does the library load, and how big is it? */
export async function describeLibrary(lib: ReferenceLibrary): Promise<{ ok: boolean; files: number; detail: string }> {
  const exists = await fs.stat(lib.path).catch(() => null);
  if (!exists) return { ok: false, files: 0, detail: `"${lib.path}" does not exist.` };
  const index = await getLibraryIndex(lib);
  if (!index) return { ok: false, files: 0, detail: `"${lib.path}" could not be read.` };
  if (index.files === 0) {
    return { ok: false, files: 0, detail: `No readable documentation files (HTML, Markdown, text, .d.ts, Java, Python…) in "${lib.path}".` };
  }
  return { ok: true, files: index.files, detail: `${index.files.toLocaleString()} files, ${(index.bytes / 1e6).toFixed(1)} MB of text.` };
}

// ── Lookups ───────────────────────────────────────────────────────────────

function normalise(identifier: string): string {
  return identifier
    .trim()
    .replace(/^[`'"]+|[`'",.;:]+$/g, '')
    .replace(/^new\s+/, '')
    .replace(/\([\s\S]*$/, '') // calls: foo(x) → foo
    .replace(/<[^<>]*>$/, '') // generics: List<T> → List
    .trim();
}

function excerpt(text: string, token: string): string {
  const i = text.indexOf(token);
  if (i < 0) return '';
  return text.slice(Math.max(0, i - 300), i + 700).replace(/\s+/g, ' ').trim();
}

function matchesTool(claimTool: string | undefined, libTool: string): boolean {
  if (!claimTool) return false;
  const a = claimTool.toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = libTool.toLowerCase().replace(/[^a-z0-9]/g, '');
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Check a claim against the book's reference libraries. Returns null when no
 * library applies (so other sources are tried).
 */
export async function checkLibraries(claim: Claim, libraries: ReferenceLibrary[]): Promise<Evidence | null> {
  if (libraries.length === 0 || claim.kind === 'fact') return null;
  const id = normalise(claim.identifier);
  if (id.length < 2) return null;
  // "Array.prototype.map" is JavaScript notation for the member "map" of "Array".
  const parts = id.split(/\.|::|#/).filter((p) => p && p !== 'prototype');
  const member = parts[parts.length - 1];
  const qualifier = parts.length > 1 ? parts[parts.length - 2] : null;

  const relevant = libraries.filter((l) => matchesTool(claim.tool, l.tool));
  const searchIn = relevant.length ? relevant : libraries;

  for (const lib of searchIn) {
    const index = await getLibraryIndex(lib);
    if (!index) continue;

    const exact = index.tokens.get(id);
    if (exact?.length) {
      const doc = index.docs[exact[0]];
      return { claim, verdict: 'confirmed', source: 'local-docs', reference: `${lib.tool} docs: ${doc.file}`, excerpt: excerpt(doc.text, id) };
    }
    if (qualifier) {
      const withMember = index.tokens.get(member) ?? [];
      // Static members are declared on "<Name>Constructor" interfaces in .d.ts files.
      const withQualifier = new Set([...(index.tokens.get(qualifier) ?? []), ...(index.tokens.get(`${qualifier}Constructor`) ?? [])]);
      const both = withMember.find((i) => withQualifier.has(i));
      if (both !== undefined) {
        const doc = index.docs[both];
        return {
          claim,
          verdict: 'confirmed',
          source: 'local-docs',
          reference: `${lib.tool} docs: ${doc.file}`,
          excerpt: excerpt(doc.text, member),
        };
      }
    }
  }

  // Not found anywhere. Only authoritative for a COMPLETE library of the claim's tool.
  const authoritative = relevant.filter((l) => l.complete !== false);
  if (authoritative.length) {
    return {
      claim,
      verdict: 'not-found',
      source: 'local-docs',
      reference: `${authoritative.map((l) => l.tool).join(', ')} reference library`,
      excerpt: qualifier
        ? `"${member}" does not appear together with "${qualifier}" anywhere in the ${authoritative[0].tool} documentation.`
        : `"${id}" does not appear anywhere in the ${authoritative[0].tool} documentation.`,
    };
  }
  return null;
}
