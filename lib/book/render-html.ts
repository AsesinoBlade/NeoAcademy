/**
 * Assemble a written book into one print-ready HTML document.
 *
 * Server side: Markdown → HTML (marked), math (KaTeX), code (Shiki),
 * charts (ECharts SVG), images (file URLs). Mermaid diagrams and figure
 * numbering run inside the PDF browser via an inline script, which sets
 * `window.__bookReady = true` once everything is laid out.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ChartSpec, ImageSpec } from './figures';
import { isTextDependentImagePrompt, renderChartSvg } from './figures';
import {
  type BookRecord,
  fileExists,
  imagesDir,
  listSectionRefs,
  readSection,
} from './storage';

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CALLOUT_KINDS = ['note', 'tip', 'warning', 'example', 'key idea', 'important'];

interface RenderContext {
  bookId: string;
  missingImages: number;
}

/** Render one section's Markdown body to HTML. */
async function renderSectionBody(markdown: string, ctx: RenderContext): Promise<string> {
  const { marked } = await import('marked');
  const katex = (await import('katex')).default;

  const blocks: string[] = [];
  const hold = (html: string) => {
    blocks.push(html);
    return `\n\n@@BLOCKZ${blocks.length - 1}@@\n\n`;
  };

  // 1. Fenced code / figure blocks (before math, so `$` in code is untouched).
  // Fences may be indented (e.g. a code block inside a numbered list item);
  // keep the indentation so the list structure survives, and strip it from
  // the code itself.
  const fences: Array<{ lang: string; body: string }> = [];
  let md = markdown.replace(
    /^([ \t]*)```[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm,
    (_m, indent: string, lang: string, body: string) => {
      const dedented = indent
        ? body
            .split('\n')
            .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line.trimStart()))
            .join('\n')
        : body;
      fences.push({ lang, body: dedented });
      return `${indent}@@FENCEZ${fences.length - 1}@@`;
    },
  );

  // Inline code spans are literal text: protect them from math detection
  // (CMake generator expressions like `$<BUILD_INTERFACE:${DIR}>`, `$HOME`).
  md = md.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, (_m, _ticks: string, code: string) => {
    blocks.push(`<code>${escapeHtml(code.trim())}</code>`);
    return `@@INLINEZ${blocks.length - 1}@@`;
  });

  // 2. Demote headings so the shallowest section heading becomes <h3>.
  const levels = [...md.matchAll(/^(#{1,6})\s/gm)].map((m) => m[1].length);
  const shift = levels.length ? 3 - Math.min(...levels) : 0;
  if (shift !== 0) {
    md = md.replace(/^(#{1,6})(\s)/gm, (_m, hashes: string, space: string) =>
      '#'.repeat(Math.min(6, Math.max(3, hashes.length + shift))) + space,
    );
  }

  // 3. Math: display $$...$$ then inline $...$ (avoids currency like "$5 and $10").
  md = md.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => {
    try {
      return hold(katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }));
    } catch {
      return hold(`<pre>${escapeHtml(tex)}</pre>`);
    }
  });
  // Inline math: the opening $ must not start a shell/CMake construct
  // ($<...>, ${...}, $(...)) and the closing $ must not open one either.
  md = md.replace(/(?<![\\$\w])\$(?![\s$<{(])([^$\n]{1,300}?)(?<!\s)\$(?![\w$<{(])/g, (_m, tex: string) => {
    try {
      blocks.push(katex.renderToString(tex, { displayMode: false, throwOnError: false }));
      return `@@INLINEZ${blocks.length - 1}@@`;
    } catch {
      return _m;
    }
  });

  // 4. Restore fences as rendered blocks.
  const fenceHtml = await Promise.all(fences.map((f) => renderFence(f.lang, f.body, ctx)));
  md = md.replace(/@@FENCEZ(\d+)@@/g, (_m, i) => hold(fenceHtml[Number(i)] ?? ''));

  // 5. Markdown → HTML, then swap placeholders back in.
  let html: string = await marked.parse(md, { gfm: true, breaks: false });
  html = html
    .replace(/<p>\s*@@BLOCKZ(\d+)@@\s*<\/p>/g, (_m: string, i: string) => blocks[Number(i)])
    .replace(/@@BLOCKZ(\d+)@@/g, (_m: string, i: string) => blocks[Number(i)])
    .replace(/@@INLINEZ(\d+)@@/g, (_m: string, i: string) => blocks[Number(i)]);

  // 6. Callout blockquotes: > **Note:** ...
  html = html.replace(
    /<blockquote>\s*<p><strong>([^<:]{2,20}):?<\/strong>:?/g,
    (m: string, label: string) => {
      const kind = label.trim().toLowerCase();
      if (!CALLOUT_KINDS.includes(kind)) return m;
      const cls = kind.replace(/\s+/g, '-');
      return `<blockquote class="callout callout-${cls}"><p><strong class="callout-label">${escapeHtml(label.trim())}</strong> `;
    },
  );

  // Wide tables scroll nowhere in print — wrap so CSS can shrink them.
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');

  return html;
}

async function renderFence(lang: string, body: string, ctx: RenderContext): Promise<string> {
  const caption = (text?: string, source?: string) =>
    `<figcaption><span class="fig-label"></span> ${escapeHtml(text || '')}${
      source ? ` <span class="fig-source">Source: ${escapeHtml(source)}</span>` : ''
    }</figcaption>`;

  if (lang === 'chart') {
    try {
      const spec = JSON.parse(body) as ChartSpec;
      const svg = await renderChartSvg(spec);
      return `<figure class="figure chart">${svg}${caption(spec.caption, spec.source)}</figure>`;
    } catch {
      return '';
    }
  }

  if (lang === 'mermaid') {
    const lines = body.split('\n');
    let figCaption = '';
    const source = lines
      .filter((line) => {
        const m = line.match(/^\s*%%\s*caption:\s*(.+)$/i);
        if (m) {
          figCaption = m[1].trim();
          return false;
        }
        return true;
      })
      .join('\n');
    return `<figure class="figure diagram"><pre class="mermaid">${escapeHtml(source)}</pre>${caption(figCaption)}</figure>`;
  }

  if (lang === 'image') {
    try {
      const spec = JSON.parse(body) as ImageSpec;
      // Older sections may still hold pictures of text-dependent subjects
      // (screenshots, file trees...) — those render as nonsense, so skip them.
      if (isTextDependentImagePrompt(spec.prompt || '')) return '';
      const file = path.join(imagesDir(ctx.bookId), `${spec.id}.png`);
      if (!(await fileExists(file))) {
        ctx.missingImages++;
        return '';
      }
      return `<figure class="figure image"><img src="${pathToFileURL(file).href}" alt="${escapeHtml(
        spec.caption || '',
      )}">${caption(spec.caption)}</figure>`;
    } catch {
      return '';
    }
  }

  // Ordinary code listing
  try {
    const { codeToHtml } = await import('shiki');
    const html = await codeToHtml(body, { lang: lang || 'text', theme: 'github-light' }).catch(() =>
      codeToHtml(body, { lang: 'text', theme: 'github-light' }),
    );
    return `<div class="code">${html}</div>`;
  } catch {
    return `<div class="code"><pre><code>${escapeHtml(body)}</code></pre></div>`;
  }
}

/** Resolve a package file inside node_modules (works with pnpm symlinks). */
function nodeModuleFile(...segments: string[]): string {
  return path.join(process.cwd(), 'node_modules', ...segments);
}

export interface RenderedBook {
  html: string;
  sectionCount: number;
  missingSections: number;
  missingImages: number;
}

export async function renderBookHtml(book: BookRecord): Promise<RenderedBook> {
  const ctx: RenderContext = { bookId: book.id, missingImages: 0 };
  const refs = listSectionRefs(book.outline);
  let missingSections = 0;

  const toc: string[] = [];
  const chapters: string[] = [];

  for (let ci = 0; ci < book.outline.length; ci++) {
    const chapter = book.outline[ci];
    const chapterRefs = refs.filter((r) => r.chapterIndex === ci);
    const chapterId = `ch-${ci + 1}`;

    toc.push(
      `<li class="toc-chapter"><a href="#${chapterId}"><span class="toc-num">${ci + 1}</span>${escapeHtml(
        chapter.title,
      )}</a><ol>${chapterRefs
        .map(
          (r) =>
            `<li><a href="#sec-${r.id}"><span class="toc-num">${r.sectionNumber}</span>${escapeHtml(
              r.title,
            )}</a></li>`,
        )
        .join('')}</ol></li>`,
    );

    const sections: string[] = [];
    for (const ref of chapterRefs) {
      const markdown = await readSection(book.id, ref.id);
      if (!markdown) {
        missingSections++;
        continue;
      }
      const body = await renderSectionBody(markdown, ctx);
      sections.push(
        `<section class="book-section" id="sec-${ref.id}"><h2><span class="sec-num">${ref.sectionNumber}</span>${escapeHtml(
          ref.title,
        )}</h2>${body}</section>`,
      );
    }

    chapters.push(
      `<article class="chapter" id="${chapterId}" data-chapter="${ci + 1}">
        <header class="chapter-opener">
          <div class="chapter-kicker">Chapter ${ci + 1}</div>
          <h1>${escapeHtml(chapter.title)}</h1>
          ${chapter.description ? `<p class="chapter-intro">${escapeHtml(chapter.description)}</p>` : ''}
        </header>
        ${sections.join('\n')}
      </article>`,
    );
  }

  const coverFile = path.join(imagesDir(book.id), 'cover.png');
  const coverImage = (await fileExists(coverFile))
    ? `<img class="cover-image" src="${pathToFileURL(coverFile).href}" alt="">`
    : '';

  const katexCss = await fs
    .readFile(nodeModuleFile('katex', 'dist', 'katex.min.css'), 'utf-8')
    .then((css) =>
      css.replace(/url\(fonts\//g, `url(${pathToFileURL(nodeModuleFile('katex', 'dist', 'fonts')).href}/`),
    )
    .catch(() => '');
  const mermaidScript = pathToFileURL(nodeModuleFile('mermaid', 'dist', 'mermaid.min.js')).href;

  const date = new Date().toLocaleDateString('en-IE', { year: 'numeric', month: 'long' });

  const html = `<!doctype html>
<html lang="${escapeHtml(book.language || 'en')}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(book.title)}</title>
<style>${katexCss}</style>
<style>${BOOK_CSS}</style>
</head>
<body>
<section class="cover">
  ${coverImage}
  <div class="cover-text">
    <h1 class="cover-title">${escapeHtml(book.title)}</h1>
    ${book.subtitle ? `<p class="cover-subtitle">${escapeHtml(book.subtitle)}</p>` : ''}
    <p class="cover-meta">${escapeHtml(date)} · Generated with NeoAcademy</p>
  </div>
</section>
<nav class="toc">
  <h1>Contents</h1>
  <ol>${toc.join('\n')}</ol>
</nav>
${chapters.join('\n')}
<script src="${mermaidScript}"></script>
<script>
(async () => {
  // Number figures per chapter: Figure 3.1, 3.2, ...
  document.querySelectorAll('article.chapter').forEach((chapter) => {
    let n = 0;
    chapter.querySelectorAll('figure.figure').forEach((fig) => {
      const label = fig.querySelector('.fig-label');
      if (label) label.textContent = 'Figure ' + chapter.dataset.chapter + '.' + (++n) + '.';
    });
  });
  try {
    if (window.mermaid) {
      mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose',
        fontFamily: 'Segoe UI, Arial, sans-serif', flowchart: { useMaxWidth: true } });
      const nodes = Array.from(document.querySelectorAll('pre.mermaid'));
      for (const node of nodes) {
        try {
          await mermaid.run({ nodes: [node] });
        } catch (e) {
          // Invalid diagram: drop the figure rather than print an error box.
          node.closest('figure')?.remove();
        }
      }
      // Renumber after any removals.
      document.querySelectorAll('article.chapter').forEach((chapter) => {
        let n = 0;
        chapter.querySelectorAll('figure.figure').forEach((fig) => {
          const label = fig.querySelector('.fig-label');
          if (label) label.textContent = 'Figure ' + chapter.dataset.chapter + '.' + (++n) + '.';
        });
      });
    }
  } finally {
    await Promise.all(Array.from(document.images).map((img) =>
      img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
    window.__bookReady = true;
  }
})();
</script>
</body>
</html>`;

  return { html, sectionCount: refs.length, missingSections, missingImages: ctx.missingImages };
}

const BOOK_CSS = `
@page { size: A4; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: Cambria, Georgia, 'Times New Roman', serif; font-size: 10.5pt; line-height: 1.55;
  color: #1a1a1a; margin: 0; hyphens: auto; text-align: justify; }
h1, h2, h3, h4, h5, .chapter-kicker, .toc, figcaption, table, .cover { font-family: 'Segoe UI', Calibri, Arial, sans-serif; text-align: left; }
h3 { font-size: 12.5pt; margin: 1.4em 0 0.4em; color: #111827; break-after: avoid; }
h4 { font-size: 11pt; margin: 1.1em 0 0.3em; color: #374151; break-after: avoid; }
h5, h6 { font-size: 10.5pt; margin: 1em 0 0.3em; break-after: avoid; }
p { margin: 0 0 0.7em; orphans: 3; widows: 3; }
a { color: #1d4ed8; text-decoration: none; }
ul, ol { margin: 0 0 0.8em 1.4em; padding: 0; }
li { margin: 0.15em 0; }

/* Cover */
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; break-after: page; }
.cover-image { width: 100%; max-height: 120mm; object-fit: cover; border-radius: 4px; margin-bottom: 14mm; }
.cover-title { font-size: 34pt; line-height: 1.12; margin: 0 0 6mm; color: #0f172a; }
.cover-subtitle { font-size: 15pt; color: #475569; margin: 0 0 14mm; }
.cover-meta { font-size: 9.5pt; color: #94a3b8; }

/* Contents */
.toc { break-after: page; }
.toc h1 { font-size: 22pt; margin: 0 0 8mm; }
.toc ol { list-style: none; margin: 0; padding: 0; }
.toc-chapter { margin: 0 0 3mm; break-inside: avoid; }
.toc-chapter > a { font-weight: 600; font-size: 11pt; color: #0f172a; }
.toc-chapter ol { margin: 1mm 0 0 9mm; }
.toc-chapter ol li { font-size: 9.5pt; margin: 0.6mm 0; }
.toc-chapter ol a { color: #334155; }
.toc-num { display: inline-block; min-width: 9mm; color: #64748b; }

/* Chapters */
.chapter { break-before: page; }
.chapter-opener { margin: 18mm 0 10mm; padding-bottom: 6mm; border-bottom: 2px solid #1d4ed8; }
.chapter-kicker { text-transform: uppercase; letter-spacing: 0.18em; font-size: 9pt; color: #1d4ed8; font-weight: 700; }
.chapter-opener h1 { font-size: 26pt; line-height: 1.15; margin: 2mm 0 4mm; color: #0f172a; }
.chapter-intro { font-size: 11pt; color: #475569; font-style: italic; text-align: left; }
.book-section h2 { font-size: 15pt; margin: 1.6em 0 0.6em; color: #0f172a; break-after: avoid; }
.sec-num { color: #1d4ed8; margin-right: 3mm; }

/* Figures */
figure.figure { margin: 1.2em 0; text-align: center; break-inside: avoid; }
figure.figure svg { max-width: 100%; height: auto; }
figure.image img { max-width: 100%; max-height: 125mm; border-radius: 3px; }
figcaption { font-size: 8.8pt; color: #4b5563; margin-top: 2mm; text-align: center; }
.fig-label { font-weight: 700; color: #1f2937; }
.fig-source { color: #9ca3af; font-style: italic; }
pre.mermaid { background: none; border: 0; text-align: center; white-space: pre; font-size: 0; }
pre.mermaid svg { font-size: 12px; }

/* Code */
.code { margin: 0.8em 0 1em; break-inside: avoid; }
.code pre { font-family: Consolas, 'Cascadia Mono', Menlo, monospace; font-size: 8.4pt; line-height: 1.45;
  padding: 3mm 4mm; border-radius: 4px; border: 1px solid #e5e7eb; background: #f8fafc !important;
  white-space: pre-wrap; word-break: break-word; text-align: left; }
code { font-family: Consolas, 'Cascadia Mono', Menlo, monospace; font-size: 0.9em; }
p code, li code, td code { background: #f1f5f9; padding: 0.05em 0.3em; border-radius: 3px; }

/* Tables */
.table-wrap { margin: 1em 0; break-inside: avoid; }
table { border-collapse: collapse; width: 100%; font-size: 8.8pt; }
th { background: #eff6ff; color: #1e3a8a; font-weight: 600; }
th, td { border: 1px solid #d1d5db; padding: 1.4mm 2mm; vertical-align: top; text-align: left; }
tr:nth-child(even) td { background: #fafafa; }

/* Callouts */
blockquote { margin: 1em 0; padding: 2.5mm 4mm; border-left: 3px solid #cbd5e1; background: #f8fafc; color: #334155; break-inside: avoid; }
blockquote p:last-child { margin-bottom: 0; }
.callout-label { margin-right: 1mm; }
.callout-note, .callout-key-idea, .callout-important { border-color: #2563eb; background: #eff6ff; }
.callout-tip { border-color: #16a34a; background: #f0fdf4; }
.callout-warning { border-color: #d97706; background: #fffbeb; }
.callout-example { border-color: #7c3aed; background: #f5f3ff; }

.katex-display { margin: 0.9em 0; overflow: hidden; }
`;
