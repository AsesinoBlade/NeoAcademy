/**
 * Remove editorial artefacts that must never reach the reader:
 *  - references to the internal principles ledger ("(principle 18)");
 *  - "Check your version" notes placed inside table cells or list items, where
 *    a Markdown blockquote can't render — rewritten as an inline italic note.
 */
export function cleanEditorialArtifacts(markdown: string): string {
  let text = stripLeakedPrompt(markdown).text
    // "(principle 18)", "(see principles 3 and 7)", "(per principle #36)"
    .replace(/\s*\((?:see |cf\.? |per |as in )?principles?\s*#?\d+(?:\s*(?:,|and|&)\s*#?\d+)*\)/gi, '')
    // "as established in principle 18" → "as established earlier"
    .replace(/\b(in|by|from|under|per)\s+principles?\s*#?\d+\b/gi, '$1 the earlier sections')
    .replace(/\bprinciples?\s*#?\d+\b/gi, 'an earlier section');

  text = text
    .split('\n')
    .map((line) => {
      const at = line.indexOf('> **Check your version:**');
      if (at < 0) return line;
      const before = line.slice(0, at);
      // A proper note: a blockquote line of its own.
      if (/^\s*$/.test(before)) return line;
      const inTable = before.includes('|');
      const rest = line.slice(at + '> **Check your version:**'.length);
      if (inTable) {
        // Note ends at the next cell boundary.
        const end = rest.indexOf('|');
        const note = (end < 0 ? rest : rest.slice(0, end)).trim();
        const after = end < 0 ? '' : rest.slice(end);
        return `${before}*(Check your version: ${note})* ${after}`.replace(/\s+\|/g, ' |');
      }
      return `${before}*(Check your version: ${rest.trim()})*`;
    })
    .join('\n');
  return text;
}


// ── Leaked review prompt ────────────────────────────────────────────────────
// The reviewer sometimes echoes its whole input (table of contents, evidence
// list, calculation report...) before the section. Those headings come from
// the book-review prompt and never belong in a reader's text.
const PROMPT_MARKER =
  /^\s*#{0,3}\s*(Table of contents\s*$|Consistency conflicts \(recommendations|Editorial stance on the request|Code sample check \(compiled|Calculation check \(computed|Reference evidence for the claims|Project context\s*$|Project specification\s*$)/i;
const ECHOED_SECTION_HEADING = /^\s*#{0,3}\s*Section \d+(?:\.\d+)*:\s+[^\n]{1,140}$/;

export function stripLeakedPrompt(markdown: string): { text: string; leaked: boolean; recovered: boolean } {
  const lines = markdown.split('\n');
  const markers = lines.map((l, i) => (PROMPT_MARKER.test(l) ? i : -1)).filter((i) => i >= 0);
  let out = lines;
  let leaked = false;
  let recovered = true;
  // Two or more prompt headings = an echoed prompt (one could be a coincidence).
  if (markers.length >= 2) {
    leaked = true;
    const last = markers[markers.length - 1];
    const resume = lines.findIndex((l, i) => i > last && ECHOED_SECTION_HEADING.test(l));
    if (resume >= 0) out = [...lines.slice(0, markers[0]), ...lines.slice(resume + 1)];
    else recovered = false;
  }
  // A lone echoed "## Section 4.1: Title" line at the top of the section.
  const firstContent = out.findIndex((l) => l.trim());
  if (firstContent >= 0 && ECHOED_SECTION_HEADING.test(out[firstContent])) {
    leaked = true;
    out = [...out.slice(0, firstContent), ...out.slice(firstContent + 1)];
  }
  return { text: leaked ? out.join('\n').replace(/^\s+/, '') : markdown, leaked, recovered };
}

// ── Reader notes moved to the back of the book ──────────────────────────────
// "Check your version" notes are useful but interrupt the reading; the PDF
// collects them in an appendix instead of printing them inside the text.
export function extractReaderNotes(markdown: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const lines = markdown.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*>\s*\*\*Check your version:?\*\*:?\s*(.*)$/i);
    if (m) {
      const parts = [m[1]];
      // A blockquote note can continue on following "> " lines.
      while (i + 1 < lines.length && /^\s*>\s*\S/.test(lines[i + 1]) && !/\*\*[^*]+:\*\*/.test(lines[i + 1])) {
        parts.push(lines[++i].replace(/^\s*>\s*/, ''));
      }
      notes.push(parts.join(' ').trim());
      continue;
    }
    // Inline form, e.g. inside a table cell or list item.
    kept.push(
      lines[i].replace(/\s*\*\(Check your version:\s*([^)]*(?:\([^)]*\)[^)]*)*)\)\*/gi, (_all, note: string) => {
        notes.push(note.trim());
        return '';
      }),
    );
  }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n'), notes: notes.filter(Boolean) };
}
