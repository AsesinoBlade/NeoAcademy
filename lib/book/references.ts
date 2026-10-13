/**
 * Reference evidence for fact-checking book sections.
 *
 * Claims (command names, arguments, variables, generator expressions, CLI
 * options, APIs) are checked against, in order:
 *   1. Local tool documentation — e.g. `cmake --help-command <name>`. Exact,
 *      offline, and matches the reader's installed version.
 *   2. Web search (Tavily → Brave → DuckDuckGo via lib/web-search).
 *   3. Nothing: the claim is reported as unverified.
 *
 * Results are cached on disk (data/reference-cache) because one book makes
 * hundreds of lookups and many repeat.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createLogger } from '@/lib/logger';

const log = createLogger('BookReferences');

export interface Claim {
  /** Exact identifier as written, e.g. "add_executable", "$<REMOVE:...>", "--preset". */
  identifier: string;
  kind:
    | 'command'
    | 'command-argument'
    | 'variable'
    | 'property'
    | 'module'
    | 'generator-expression'
    | 'cli-option'
    | 'api'
    | 'fact';
  /** Tool the identifier belongs to (cmake, ctest, git, python, gcc...). */
  tool?: string;
  /** For command-argument: the command it is claimed to belong to. */
  parent?: string;
  /** The specific statement being made, in a sentence. */
  statement: string;
  /** Web search query to use if no local documentation applies. */
  query?: string;
}

export interface Evidence {
  claim: Claim;
  verdict: 'confirmed' | 'not-found' | 'unknown';
  source: 'local-docs' | 'web' | 'none';
  reference: string;
  excerpt: string;
}

/** Tools we may execute for documentation (never through a shell). */
const TOOL_ALLOWLIST = new Set([
  'cmake', 'ctest', 'cpack', 'make', 'ninja', 'git', 'python', 'python3', 'pip',
  'node', 'npm', 'gcc', 'g++', 'clang', 'clang++', 'docker',
]);

const CACHE_DIR = path.join(process.cwd(), 'data', 'reference-cache');
const memoryCache = new Map<string, string | null>();

function runTool(tool: string, args: string[], timeoutMs = 15000): Promise<string | null> {
  const key = `${tool} ${args.join(' ')}`;
  if (memoryCache.has(key)) return Promise.resolve(memoryCache.get(key)!);
  return new Promise((resolve) => {
    execFile(
      tool,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        // Unknown names make cmake exit non-zero with a message: that's an answer, not a failure.
        const out = `${stdout ?? ''}${stderr ?? ''}`;
        const result = error && !out ? null : out;
        memoryCache.set(key, result);
        resolve(result);
      },
    );
  });
}

const toolAvailability = new Map<string, Promise<boolean>>();
function toolAvailable(tool: string): Promise<boolean> {
  if (!TOOL_ALLOWLIST.has(tool)) return Promise.resolve(false);
  if (!toolAvailability.has(tool)) {
    toolAvailability.set(tool, runTool(tool, ['--version'], 8000).then((out) => !!out && out.length > 0));
  }
  return toolAvailability.get(tool)!;
}

function excerptAround(text: string, index: number, before = 2, after = 14): string {
  const lines = text.split('\n');
  let lineNo = text.slice(0, index).split('\n').length - 1;
  lineNo = Math.max(0, lineNo);
  return lines
    .slice(Math.max(0, lineNo - before), lineNo + after)
    .join('\n')
    .trim()
    .slice(0, 1500);
}

const firstLines = (text: string, n = 18) => text.split('\n').slice(0, n).join('\n').trim().slice(0, 1500);

// ── CMake: local documentation oracle ─────────────────────────────────────

async function checkCMake(claim: Claim): Promise<Evidence | null> {
  if (!(await toolAvailable('cmake'))) return null;
  const id = claim.identifier.trim();

  const helpFor = async (flag: string, name: string) => {
    const out = await runTool('cmake', [flag, name]);
    if (!out) return null;
    const missing = /is not a (CMake command|defined variable|defined property|CMake module)|not a CMake/i.test(out);
    return { out, missing };
  };

  const simple: Partial<Record<Claim['kind'], string>> = {
    command: '--help-command',
    variable: '--help-variable',
    property: '--help-property',
    module: '--help-module',
  };

  if (simple[claim.kind]) {
    const name = id.replace(/\(.*$/, '').trim();
    const result = await helpFor(simple[claim.kind]!, name);
    if (!result) return null;

    // Many commands (check_cxx_compiler_flag, FetchContent_Declare, ...) are
    // defined by modules, not built in: look them up in the module docs
    // before calling them missing.
    if (result.missing && claim.kind === 'command') {
      const modules = await runTool('cmake', ['--help-modules'], 30000);
      const marker = `.. command:: ${name}`;
      const index = modules ? modules.toLowerCase().indexOf(marker.toLowerCase()) : -1;
      if (modules && index >= 0) {
        return {
          claim,
          verdict: 'confirmed',
          source: 'local-docs',
          reference: 'cmake --help-modules (command provided by a module; include() the module first)',
          excerpt: excerptAround(modules, index, 0, 14),
        };
      }
    }
    return {
      claim,
      verdict: result.missing ? 'not-found' : 'confirmed',
      source: 'local-docs',
      reference: `cmake ${simple[claim.kind]} ${name}`,
      excerpt: result.missing ? result.out.trim().slice(0, 300) : firstLines(result.out),
    };
  }

  if (claim.kind === 'command-argument' && claim.parent) {
    const parent = claim.parent.replace(/\(.*$/, '').trim();
    const result = await helpFor('--help-command', parent);
    if (!result || result.missing) return null;
    const arg = id.replace(/[[\]<>]/g, '').trim();
    const index = result.out.indexOf(arg);
    return {
      claim,
      verdict: index >= 0 ? 'confirmed' : 'not-found',
      source: 'local-docs',
      reference: `cmake --help-command ${parent}`,
      excerpt: index >= 0 ? excerptAround(result.out, index) : `"${arg}" does not appear in the documentation of ${parent}().`,
    };
  }

  if (claim.kind === 'generator-expression') {
    const manual = await runTool('cmake', ['--help-manual', 'cmake-generator-expressions.7']);
    if (!manual) return null;
    const m = id.match(/\$<([A-Z_]+)(?::([A-Z_]+))?/);
    if (!m) return null;
    const [, name, sub] = m;
    const candidates = sub
      ? [`.. genex:: $<${name}:${sub}`, `.. genex:: $<${name}:`]
      : [`.. genex:: $<${name}:`, `.. genex:: $<${name}>`];
    for (const candidate of candidates) {
      const index = manual.indexOf(candidate);
      if (index >= 0) {
        return {
          claim,
          verdict: 'confirmed',
          source: 'local-docs',
          reference: 'cmake --help-manual cmake-generator-expressions.7',
          excerpt: excerptAround(manual, index, 0, 16),
        };
      }
    }
    return {
      claim,
      verdict: 'not-found',
      source: 'local-docs',
      reference: 'cmake --help-manual cmake-generator-expressions.7',
      excerpt: `No generator expression $<${name}${sub ? `:${sub}` : ''}...> is defined in the CMake generator expression manual.`,
    };
  }

  if (claim.kind === 'cli-option' && ['cmake', 'ctest', 'cpack'].includes(claim.tool || 'cmake')) {
    const tool = claim.tool || 'cmake';
    const manual = await runTool('cmake', ['--help-manual', `${tool}.1`]);
    if (!manual) return null;
    const option = id.split(/[\s=]/)[0];
    const index = manual.indexOf(option);
    return {
      claim,
      verdict: index >= 0 ? 'confirmed' : 'not-found',
      source: 'local-docs',
      reference: `cmake --help-manual ${tool}.1`,
      excerpt: index >= 0 ? excerptAround(manual, index) : `Option "${option}" does not appear in the ${tool} command-line manual.`,
    };
  }

  return null;
}

// ── Generic tools: `<tool> --help` for CLI options ─────────────────────────

async function checkCliOption(claim: Claim): Promise<Evidence | null> {
  const tool = (claim.tool || '').toLowerCase();
  if (claim.kind !== 'cli-option' || !(await toolAvailable(tool))) return null;
  const out = await runTool(tool, ['--help']);
  if (!out) return null;
  const option = claim.identifier.split(/[\s=]/)[0];
  const index = out.indexOf(option);
  return {
    claim,
    // Short --help output often omits options, so absence is not proof.
    verdict: index >= 0 ? 'confirmed' : 'unknown',
    source: 'local-docs',
    reference: `${tool} --help`,
    excerpt: index >= 0 ? excerptAround(out, index, 1, 4) : `"${option}" not listed in ${tool} --help (may still exist).`,
  };
}

// ── Python APIs: pydoc ─────────────────────────────────────────────────────

async function checkPython(claim: Claim): Promise<Evidence | null> {
  if (claim.kind !== 'api' || !['python', 'python3'].includes((claim.tool || '').toLowerCase())) return null;
  const python = (await toolAvailable('python')) ? 'python' : (await toolAvailable('python3')) ? 'python3' : null;
  if (!python) return null;
  const name = claim.identifier.replace(/\(.*$/, '').trim();
  if (!/^[\w.]+$/.test(name)) return null;
  const out = await runTool(python, ['-m', 'pydoc', name]);
  if (!out) return null;
  const missing = /No Python documentation found/i.test(out);
  return {
    claim,
    verdict: missing ? 'not-found' : 'confirmed',
    source: 'local-docs',
    reference: `python -m pydoc ${name}`,
    excerpt: missing ? out.trim().slice(0, 300) : firstLines(out, 14),
  };
}

// ── Web search (cached) ────────────────────────────────────────────────────

async function checkWeb(claim: Claim): Promise<Evidence | null> {
  const query = claim.query || `${claim.tool ?? ''} ${claim.identifier} documentation`.trim();
  const cacheFile = path.join(CACHE_DIR, `web-${createHash('sha1').update(query).digest('hex')}.json`);
  let results: Array<{ title: string; url: string; content: string }> | null = null;
  try {
    results = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
  } catch {
    try {
      const { webSearch } = await import('@/lib/web-search/search');
      results = (await webSearch(query, { maxResults: 3 })).map((r) => ({
        title: r.title,
        url: r.url,
        content: (r.content || '').slice(0, 700),
      }));
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(results), 'utf-8');
    } catch (error) {
      log.warn(`Web search failed for "${query}":`, error);
      return null;
    }
  }
  if (!results || results.length === 0) return null;
  return {
    claim,
    verdict: 'unknown',
    source: 'web',
    reference: results.map((r) => r.url).join(' | '),
    excerpt: results.map((r) => `[${r.title}] ${r.content}`).join('\n').slice(0, 1800),
  };
}

export async function gatherEvidence(
  claims: Claim[],
  options: { webSearch: boolean },
): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  for (const claim of claims) {
    const isCMake = (claim.tool || '').toLowerCase() === 'cmake' || claim.identifier.startsWith('$<');
    let found: Evidence | null = null;
    try {
      if (isCMake || ['ctest', 'cpack'].includes((claim.tool || '').toLowerCase())) found = await checkCMake(claim);
      if (!found) found = await checkPython(claim);
      if (!found) found = await checkCliOption(claim);
      if (!found && options.webSearch && claim.kind !== 'fact') found = await checkWeb(claim);
      if (!found && options.webSearch && claim.kind === 'fact' && claim.query) found = await checkWeb(claim);
    } catch (error) {
      log.warn(`Reference lookup failed for ${claim.identifier}:`, error);
    }
    evidence.push(
      found ?? {
        claim,
        verdict: 'unknown',
        source: 'none',
        reference: 'no reference available',
        excerpt: '',
      },
    );
  }
  return evidence;
}

export function formatEvidence(evidence: Evidence[]): string {
  if (evidence.length === 0) return '(no specific claims to check)';
  return evidence
    .map((e, i) => {
      const label =
        e.verdict === 'confirmed'
          ? 'CONFIRMED by reference'
          : e.verdict === 'not-found'
            ? 'NOT FOUND in the authoritative reference — treat as non-existent / incorrect'
            : e.source === 'web'
              ? 'web results (judge for yourself)'
              : 'UNVERIFIED (no reference available)';
      return [
        `${i + 1}. ${e.claim.identifier}${e.claim.tool ? ` [${e.claim.tool}]` : ''} — ${label}`,
        `   Statement: ${e.claim.statement}`,
        `   Source: ${e.reference}`,
        e.excerpt ? `   Excerpt:\n${e.excerpt.replace(/^/gm, '      ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}
