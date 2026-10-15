/**
 * Stage 2: assemble a book's reference library from its approved plan.
 *
 *  - tool-help: run the tool's own help/reference command (contained — see
 *    sandbox.ts) and keep its output as a document.
 *  - local-path: documentation / definition files shipped inside an installed
 *    tool ({install}/...), read as text only.
 *  - web: official documentation pages under one start URL, fetched only when
 *    the user allowed it, stored as PLAIN TEXT (HTML, scripts and styles
 *    stripped). Nothing fetched is ever executed or kept in a runnable form.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '@/lib/logger';
import { getLibraryIndex, type ReferenceLibrary } from './library';
import { runContained } from './sandbox';
import { bookDir, type BookRecord } from './storage';
import { resolveProgram, type VerificationPlan } from './verification-plan';

const log = createLogger('BookAutoReferences');

const MAX_PAGES_PER_SOURCE = 150;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_DELAY_MS = 400;

const referencesDir = (bookId: string) => path.join(bookDir(bookId), 'references');
const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'x';

/** HTML → plain text (the only form web content is ever stored in). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|iframe|object|embed)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/pre)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Fetch documentation pages under the start URL's path (same origin), as text. */
export async function crawlDocs(startUrl: string, outDir: string, maxPages = MAX_PAGES_PER_SOURCE): Promise<number> {
  const start = new URL(startUrl);
  if (start.protocol !== 'https:') return 0;
  const prefix = start.pathname.endsWith('/') ? start.pathname : start.pathname.replace(/[^/]*$/, '');
  const queue = [start.href.replace(/#.*$/, '')];
  const seen = new Set(queue);
  let saved = 0;
  await fs.mkdir(outDir, { recursive: true });

  while (queue.length && saved < maxPages) {
    const url = queue.shift()!;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'NeoAcademy documentation indexer (offline book fact-checking)', Accept: 'text/html,text/plain' },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/text\/(html|plain)/i.test(type)) continue;
      const body = (await res.text()).slice(0, MAX_PAGE_BYTES);
      const text = /html/i.test(type) ? htmlToText(body) : body;
      if (text.length > 200) {
        const name = `${String(saved).padStart(4, '0')}-${safeName(new URL(url).pathname)}.txt`;
        await fs.writeFile(path.join(outDir, name), `Source: ${url}\n\n${text}`, 'utf-8');
        saved++;
      }
      if (/html/i.test(type)) {
        for (const m of body.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
          let next: URL;
          try {
            next = new URL(m[1], url);
          } catch {
            continue;
          }
          next.hash = '';
          next.search = '';
          if (next.origin !== start.origin || !next.pathname.startsWith(prefix)) continue;
          if (/\.(png|jpe?g|gif|svg|ico|css|js|zip|gz|tar|exe|msi|dmg|pdf|woff2?|ttf|mp4|webm)$/i.test(next.pathname)) continue;
          if (!seen.has(next.href)) {
            seen.add(next.href);
            queue.push(next.href);
          }
        }
      }
    } catch {
      /* skip the page */
    }
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }
  return saved;
}

function resolveInstallPath(plan: VerificationPlan, tool: string, rel: string): string | null {
  if (!rel.includes('{install}')) return existsSync(rel) ? rel : null;
  const exe = plan.tools.find((t) => t.name.toLowerCase() === tool || t.executable?.toLowerCase() === tool)?.resolvedPath
    ?? plan.tools.find((t) => t.resolvedPath && t.name.toLowerCase().includes(tool))?.resolvedPath;
  if (!exe) return null;
  // The executable may sit in the install folder, or in bin/ or bin/<arch>/ below it.
  let dir = path.dirname(exe);
  for (let up = 0; up < 4; up++) {
    const candidate = path.normalize(rel.replace('{install}', dir));
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/** Assemble (once) and return the book's automatic reference libraries. */
export async function assembleReferences(book: BookRecord): Promise<VerificationPlan['assembled']> {
  const plan = book.verificationPlan;
  if (!plan?.decision?.approved) return undefined;
  if (plan.assembled) return plan.assembled;

  const libraries: NonNullable<VerificationPlan['assembled']>['libraries'] = [];
  const notes: string[] = [];
  const toolDirs = new Map<string, string>();
  const toolDir = async (tool: string) => {
    if (!toolDirs.has(tool)) {
      const dir = path.join(referencesDir(book.id), safeName(tool));
      await fs.mkdir(dir, { recursive: true });
      toolDirs.set(tool, dir);
    }
    return toolDirs.get(tool)!;
  };

  for (const source of plan.docSources) {
    if (source.kind === 'tool-help' && source.command?.length) {
      const work = await fs.mkdtemp(path.join(os.tmpdir(), 'neoacademy-help-'));
      try {
        const res = await runContained({
          argv: source.command,
          work,
          runsCode: !!source.executesCode,
          hostProgram: resolveProgram(plan, source.command[0]),
          allowHostCode: plan.decision.allowHostCode,
          timeoutSec: 90,
        });
        if (res.where === 'skipped') {
          notes.push(`${source.description || source.command.join(' ')}: not run — ${res.reason}.`);
        } else if (res.output.trim().length > 100) {
          // Help commands often exit non-zero; the text is what matters.
          await fs.writeFile(path.join(await toolDir(source.tool), `${source.id}.txt`), res.output, 'utf-8');
          notes.push(`${source.command.join(' ')}: ${res.output.length.toLocaleString()} characters of reference (${res.where === 'container' ? 'sandbox' : 'this PC'}).`);
        } else {
          notes.push(`${source.command.join(' ')}: produced no usable output.`);
        }
      } finally {
        await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    } else if (source.kind === 'local-path' && source.path) {
      const resolved = resolveInstallPath(plan, source.tool, source.path);
      if (resolved) {
        libraries.push({ tool: source.tool, path: resolved, files: 0, source: 'installed tool' });
        notes.push(`${source.tool}: using ${resolved}.`);
      } else {
        notes.push(`${source.tool}: ${source.path} not found on this PC.`);
      }
    } else if (source.kind === 'web' && source.url) {
      if (!plan.decision.allowWeb) {
        notes.push(`${source.url}: skipped (web documentation not allowed for this book).`);
        continue;
      }
      const out = path.join(await toolDir(source.tool), `web-${safeName(new URL(source.url).hostname)}`);
      const pages = await crawlDocs(source.url, out);
      notes.push(`${source.url}: ${pages} page(s) saved as text.`);
      log.info(`Fetched ${pages} documentation page(s) from ${source.url}`);
    }
  }

  for (const [tool, dir] of toolDirs) {
    const entries = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[]);
    if (entries.length) libraries.push({ tool, path: dir, files: entries.length, source: 'help output and documentation pages' });
  }
  // Index now so writing doesn't wait, and record sizes.
  for (const lib of libraries) {
    const index = await getLibraryIndex({ tool: lib.tool, path: lib.path });
    lib.files = index?.files ?? 0;
  }
  return { at: new Date().toISOString(), libraries: libraries.filter((l) => l.files > 0), notes };
}

/** Every reference library a book is checked against: the user's and the assembled ones. */
export function bookLibraries(book: BookRecord): ReferenceLibrary[] {
  return [
    // Chosen by the user: complete documentation of their tool.
    ...(book.referenceLibraries ?? []).map((l) => ({ ...l, complete: true })),
    // Assembled automatically: partial — confirm-only.
    ...((book.verificationPlan?.assembled?.libraries ?? []).map((l) => ({ tool: l.tool, path: l.path, complete: false }))),
  ];
}
