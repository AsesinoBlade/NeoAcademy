/**
 * Remove editorial artefacts that must never reach the reader:
 *  - references to the internal principles ledger ("(principle 18)");
 *  - "Check your version" notes placed inside table cells or list items, where
 *    a Markdown blockquote can't render — rewritten as an inline italic note.
 */
export function cleanEditorialArtifacts(markdown: string): string {
  let text = markdown
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
