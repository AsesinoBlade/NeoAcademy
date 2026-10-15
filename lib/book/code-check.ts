/**
 * Compile the code samples in a book section with the real compilers.
 *
 * Languages: TypeScript/JavaScript (NeoAcademy's own `typescript`), C/C++
 * (g++ / clang++), Java (javac, against BOOK_JAVA_CLASSPATH or Ghidra's jars
 * from GHIDRA_INSTALL_DIR) and Python (syntax via py_compile). Missing
 * compilers are reported as "unavailable", never as errors in the book.
 *
 * Skipped: deliberately broken examples, fragments with placeholders, and
 * (for books with a running project) complete project files, which the
 * build checkpoints already compile.
 */
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '@/lib/logger';
import { scanForDangerousCode } from './code-scan';
import { runContained, type ExecResult } from './sandbox';
import { fillArgs, findExecutable, resolveProgram, type PlanCheck, type VerificationPlan } from './verification-plan';

const log = createLogger('BookCodeCheck');

type Lang = 'ts' | 'cpp' | 'c' | 'java' | 'python';

export interface CodeSample {
  id: string;
  /** Built-in checker family, if any. */
  lang: Lang | null;
  /** The code fence's language, lower case (e.g. "pascal", "papyrus"). */
  fence: string;
  code: string;
  /** First meaningful line, so the editor can find the block. */
  quote: string;
  tsx?: boolean;
}

export interface CodeSampleResult {
  sample: CodeSample;
  status: 'ok' | 'errors' | 'unverifiable';
  messages: string[];
}

export interface CodeCheckReport {
  checked: number;
  withErrors: number;
  results: CodeSampleResult[];
  unavailable: string[];
}

const LANGS: Record<string, Lang> = {
  ts: 'ts', typescript: 'ts', tsx: 'ts', js: 'ts', javascript: 'ts', jsx: 'ts', mjs: 'ts',
  cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  c: 'c',
  java: 'java',
  python: 'python', py: 'python', python3: 'python',
};

const BROKEN_HINT = /\b(broken|wrong|incorrect|won'?t compile|doesn'?t compile|does not compile|fails? to compile|compil(e|ation) error|bad example|anti-?pattern|don'?t do this|before the fix|buggy|bugged)\b/i;
const PLACEHOLDER = /^\s*(?:(?:\/\/|#|\/\*)\s*)?(?:\.\.\.|…)(?:\s|$)/m;

export function extractCodeSamples(
  markdown: string,
  options: { skipProjectFiles: boolean; extraLanguages?: string[] },
): CodeSample[] {
  const extra = new Set((options.extraLanguages ?? []).map((l) => l.toLowerCase()));
  const samples: CodeSample[] = [];
  const re = /^([ \t]*)```[ \t]*([\w+#-]+)[^\n]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm;
  for (const m of markdown.matchAll(re)) {
    const fence = m[2].toLowerCase();
    const lang = LANGS[fence] ?? null;
    if (!lang && !extra.has(fence)) continue;
    const indent = m[1];
    const code = indent ? m[3].split('\n').map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n') : m[3];
    const firstLine = code.split('\n', 1)[0] ?? '';
    if (options.skipProjectFiles && /File:\s*\S/.test(firstLine)) continue;
    if (PLACEHOLDER.test(code)) continue;
    // Deliberately broken examples: say so just before the block or in its first lines.
    const before = markdown.slice(Math.max(0, (m.index ?? 0) - 300), m.index ?? 0);
    if (BROKEN_HINT.test(before.split('\n').slice(-3).join(' ')) || BROKEN_HINT.test(code.split('\n').slice(0, 3).join(' '))) continue;
    if (/\/\/\s*(error|❌)|#\s*(error|❌)/i.test(code)) continue;
    // Label: the first meaningful line, skipping comments and import/include boilerplate.
    const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
    const quote =
      lines.find((l) => !/^(\/\/|#|\/\*|\*|import\b|from\b|package\b|using\b|@)/.test(l)) ?? lines[0] ?? firstLine.trim();
    samples.push({ id: `s${samples.length + 1}`, lang, fence, code, quote: quote.slice(0, 80), tsx: /^(tsx|jsx)$/i.test(m[2]) });
  }
  return samples.slice(0, 25);
}

function run(cmd: string, args: string[], opts: { cwd: string; input?: string; timeoutMs?: number }): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        const code = error ? ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1) : 0;
        resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

// ── Per-language checkers ────────────────────────────────────────────────

async function checkTypeScript(samples: CodeSample[], work: string): Promise<CodeSampleResult[]> {
  const script = path.join(process.cwd(), 'lib', 'book', 'code', 'check_ts.cjs');
  const res = await run(process.execPath, [script], {
    cwd: process.cwd(),
    input: JSON.stringify(samples.map((s) => ({ id: s.id, code: s.code, tsx: s.tsx }))),
    timeoutMs: 120000,
  });
  void work;
  if (res.code !== 0) {
    log.warn(`TypeScript checker failed: ${res.out.slice(-300)}`);
    return samples.map((sample) => ({ sample, status: 'unverifiable', messages: ['TypeScript checker failed'] }));
  }
  const out = JSON.parse(res.out) as Array<{ id: string; errors: Array<{ code: number; line: number; message: string }> }>;
  return samples.map((sample) => {
    const r = out.find((x) => x.id === sample.id);
    const msgs = (r?.errors ?? []).map((e) => `line ${e.line}: TS${e.code}: ${e.message.split('\n')[0]}`);
    return { sample, status: msgs.length ? 'errors' : 'ok', messages: msgs };
  });
}

/** A complete C/C++ file: includes or a main(); otherwise it's a fragment. */
const looksComplete = (code: string) => /^\s*#\s*include\b/m.test(code) || /\bint\s+main\s*\(/.test(code);

interface RunCtx {
  work: string;
  /** Project headers copied into the scratch folder (container paths). */
  includeDirs: string[];
  allowHostCode: boolean;
}

const skippedReason = (res: ExecResult) => res.reason ?? 'could not run';

async function checkCpp(samples: CodeSample[], ctx: RunCtx): Promise<CodeSampleResult[] | 'unavailable'> {
  const host = (await findExecutable('g++')) ?? (await findExecutable('clang++'));
  const results: CodeSampleResult[] = [];
  for (const sample of samples) {
    if (!looksComplete(sample.code)) {
      results.push({ sample, status: 'unverifiable', messages: ['fragment (no #include or main)'] });
      continue;
    }
    const ext = sample.lang === 'c' ? 'c' : 'cpp';
    await fs.writeFile(path.join(ctx.work, `${sample.id}.${ext}`), sample.code, 'utf-8');
    const compiler = host && /clang/i.test(path.basename(host)) ? 'clang++' : 'g++';
    const res = await runContained({
      argv: [compiler, sample.lang === 'c' ? '-xc' : '-xc++', sample.lang === 'c' ? '-std=c17' : '-std=c++20', '-fsyntax-only',
        ...ctx.includeDirs.flatMap((d) => ['-I', d]), `/work/${sample.id}.${ext}`],
      work: ctx.work, runsCode: false, hostProgram: host, timeoutSec: 90,
    });
    if (res.where === 'skipped') return 'unavailable';
    if (res.code === 0) {
      results.push({ sample, status: 'ok', messages: [] });
      continue;
    }
    const missingHeader = res.output.match(/fatal error: ([^:\n]+): No such file or directory/);
    if (missingHeader) {
      results.push({ sample, status: 'unverifiable', messages: [`needs ${missingHeader[1]}, which is not available here`] });
      continue;
    }
    const errors = res.output
      .split('\n')
      .filter((l) => /\berror\b/.test(l))
      .map((l) => l.replace(/^.*?:(\d+):\d+:\s*error:\s*/, 'line $1: '))
      .slice(0, 6);
    results.push({ sample, status: errors.length ? 'errors' : 'ok', messages: errors });
  }
  return results;
}

async function javaClasspath(): Promise<string | null> {
  if (process.env.BOOK_JAVA_CLASSPATH?.trim()) return process.env.BOOK_JAVA_CLASSPATH.trim();
  const ghidra = process.env.GHIDRA_INSTALL_DIR?.trim();
  if (!ghidra || !existsSync(ghidra)) return null;
  const jars: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name.endsWith('.jar')) jars.push(p);
    }
  };
  await walk(path.join(ghidra, 'Ghidra'), 0);
  return jars.length ? jars.join(path.delimiter) : null;
}

async function checkJava(samples: CodeSample[], ctx: RunCtx): Promise<CodeSampleResult[] | 'unavailable'> {
  // Library jars (e.g. Ghidra's) live on this PC: compiling there is safe (javac -proc:none runs no code).
  const cp = await javaClasspath();
  const host = await findExecutable('javac');
  const results: CodeSampleResult[] = [];
  for (const sample of samples) {
    const cls = sample.code.match(/\b(?:public\s+)?(?:final\s+|abstract\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/);
    if (!cls) {
      results.push({ sample, status: 'unverifiable', messages: ['fragment (no class declaration)'] });
      continue;
    }
    const dir = path.join(ctx.work, sample.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${cls[1]}.java`), sample.code, 'utf-8');
    const res = await runContained({
      argv: ['javac', '-proc:none', '-d', `/work/${sample.id}`, ...(cp && host ? ['-cp', cp] : []), `/work/${sample.id}/${cls[1]}.java`],
      work: ctx.work, runsCode: false, hostProgram: host, preferHost: !!(cp && host), timeoutSec: 120,
    });
    if (res.where === 'skipped') return 'unavailable';
    if (res.code === 0) {
      results.push({ sample, status: 'ok', messages: [] });
      continue;
    }
    const missingPkg = res.output.match(/package ([\w.]+) does not exist/);
    if (missingPkg && !missingPkg[1].startsWith('java')) {
      results.push({ sample, status: 'unverifiable', messages: [`needs ${missingPkg[1]} (set GHIDRA_INSTALL_DIR or BOOK_JAVA_CLASSPATH to check it)`] });
      continue;
    }
    const outLines = res.output.split('\n');
    const errors: string[] = [];
    outLines.forEach((l, i) => {
      if (!/error:/.test(l)) return;
      let msg = l.replace(/^.*?\.java:(\d+):\s*error:\s*/, 'line $1: ');
      const symbol = outLines.slice(i + 1, i + 5).find((x) => /^\s*symbol:/.test(x));
      if (symbol) msg += ` (${symbol.trim()})`;
      errors.push(msg);
    });
    results.push({ sample, status: errors.length ? 'errors' : 'ok', messages: errors.slice(0, 6) });
  }
  return results;
}

async function checkPython(samples: CodeSample[], ctx: RunCtx): Promise<CodeSampleResult[] | 'unavailable'> {
  const host = (await findExecutable('python')) ?? (await findExecutable('python3'));
  const results: CodeSampleResult[] = [];
  for (const sample of samples) {
    await fs.writeFile(path.join(ctx.work, `${sample.id}.py`), sample.code, 'utf-8');
    // py_compile only compiles; it does not run the sample.
    const res = await runContained({ argv: ['python3', '-m', 'py_compile', `/work/${sample.id}.py`], work: ctx.work, runsCode: false, hostProgram: host, timeoutSec: 60 });
    if (res.where === 'skipped') return 'unavailable';
    const msg = res.output.trim().split('\n').filter((l) => /Error/.test(l)).slice(-2);
    results.push({ sample, status: res.code === 0 ? 'ok' : 'errors', messages: res.code === 0 ? [] : msg });
  }
  return results;
}

/** A check from the book's approved verification plan, for any language. */
async function checkPlanned(samples: CodeSample[], check: PlanCheck, plan: VerificationPlan, ctx: RunCtx): Promise<CodeSampleResult[]> {
  const results: CodeSampleResult[] = [];
  const fixtures = Object.fromEntries(plan.fixtures.filter((f) => f.path).map((f) => [f.name, f.path!]));
  for (const sample of samples) {
    if (check.completeWhen && !new RegExp(check.completeWhen, 'm').test(sample.code)) {
      results.push({ sample, status: 'unverifiable', messages: ['fragment (not a complete unit)'] });
      continue;
    }
    if (check.executesCode) {
      const risky = scanForDangerousCode(sample.code);
      if (risky.length) {
        results.push({ sample, status: 'unverifiable', messages: [`not run: the sample uses ${risky.join(', ')}`] });
        continue;
      }
    }
    const dir = path.join(ctx.work, sample.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, check.fileName), sample.code, 'utf-8');
    const argv = fillArgs(plan, check.command, { file: `/work/${sample.id}/${check.fileName}`, dir: `/work/${sample.id}` });
    if (!argv) {
      results.push({ sample, status: 'unverifiable', messages: ['a required input (fixture) was not provided'] });
      continue;
    }
    const containerArgv = argv.map((a) => {
      let v = a;
      for (const [n, p] of Object.entries(fixtures)) v = v.split(p).join(`/fixtures/${n}`);
      return v;
    });
    const res = await runContained({
      argv: containerArgv,
      work: ctx.work,
      runsCode: check.executesCode,
      hostProgram: resolveProgram(plan, argv[0]),
      allowHostCode: ctx.allowHostCode,
      fixtures,
      timeoutSec: check.timeoutSec ?? 60,
    });
    if (res.where === 'skipped') {
      results.push({ sample, status: 'unverifiable', messages: [`not checked: ${skippedReason(res)}`] });
      continue;
    }
    const failedByOutput = check.failureOutput ? new RegExp(check.failureOutput, 'm').test(res.output) : false;
    const ok = (check.successExitCodes ?? [0]).includes(res.code) && !failedByOutput && !res.reason;
    const errors = ok
      ? []
      : (res.output.split('\n').filter((l) => /error|fatal|exception|traceback|failed|not found|undefined/i.test(l)).slice(0, 6).map((l) => l.trim()) || []);
    results.push({
      sample,
      status: ok ? 'ok' : 'errors',
      messages: ok ? [] : errors.length ? errors : [res.reason ?? res.output.trim().split('\n').slice(-3).join(' ')],
    });
  }
  return results;
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function checkCodeSamples(
  markdown: string,
  options: {
    skipProjectFiles: boolean;
    /** Host folder of the book's project; its headers are made available to C/C++ samples. */
    projectRoot?: string;
    includeDirs?: string[];
    plan?: VerificationPlan;
  },
): Promise<CodeCheckReport> {
  const plan = options.plan?.decision?.approved ? options.plan : undefined;
  const planChecks = plan?.checks ?? [];
  const samples = extractCodeSamples(markdown, {
    skipProjectFiles: options.skipProjectFiles,
    extraLanguages: planChecks.flatMap((c) => c.languages),
  });
  const report: CodeCheckReport = { checked: 0, withErrors: 0, results: [], unavailable: [] };
  if (samples.length === 0) return report;

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'neoacademy-code-'));
  try {
    // Project headers go into the scratch folder (it is all the sandbox can see).
    const includeDirs: string[] = [];
    if (options.projectRoot && options.includeDirs?.length && existsSync(options.projectRoot)) {
      await fs.cp(options.projectRoot, path.join(work, '_project'), { recursive: true });
      for (const d of options.includeDirs) {
        const rel = path.relative(options.projectRoot, d).split(path.sep).join('/');
        if (!rel.startsWith('..')) includeDirs.push(`/work/_project/${rel}`);
      }
    }
    const ctx: RunCtx = { work, includeDirs, allowHostCode: !!plan?.decision?.allowHostCode };

    // Planned checks take precedence for their languages.
    const planned = new Set<string>();
    for (const check of planChecks) {
      const group = samples.filter((s) => check.languages.includes(s.fence) && !planned.has(s.id));
      if (!group.length) continue;
      group.forEach((s) => planned.add(s.id));
      const res = await checkPlanned(group, check, plan!, ctx).catch((error) => {
        log.warn(`${check.label} failed:`, error);
        return [] as CodeSampleResult[];
      });
      report.results.push(...res);
      const skipped = res.filter((r) => r.messages[0]?.startsWith('not checked:'));
      if (skipped.length) report.unavailable.push(`${check.label} (${skipped[0].messages[0].replace(/^not checked: /, '')})`);
    }

    const rest = samples.filter((s) => !planned.has(s.id));
    const byLang = (l: Lang[]) => rest.filter((s) => s.lang && l.includes(s.lang));
    const groups: Array<[string, CodeSample[], () => Promise<CodeSampleResult[] | 'unavailable'>]> = [
      ['TypeScript', byLang(['ts']), () => checkTypeScript(byLang(['ts']), work)],
      ['C/C++ (g++ or clang++, or the sandbox)', byLang(['cpp', 'c']), () => checkCpp(byLang(['cpp', 'c']), ctx)],
      ['Java (javac, or the sandbox)', byLang(['java']), () => checkJava(byLang(['java']), ctx)],
      ['Python (or the sandbox)', byLang(['python']), () => checkPython(byLang(['python']), ctx)],
    ];
    for (const [label, group, runGroup] of groups) {
      if (group.length === 0) continue;
      const res = await runGroup().catch((error) => {
        log.warn(`${label} check failed:`, error);
        return 'unavailable' as const;
      });
      if (res === 'unavailable') {
        report.unavailable.push(label);
        continue;
      }
      report.results.push(...res);
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
  report.checked = report.results.filter((r) => r.status !== 'unverifiable').length;
  report.withErrors = report.results.filter((r) => r.status === 'errors').length;
  return report;
}

export function formatCodeReport(report: CodeCheckReport): string {
  if (report.results.length === 0 && report.unavailable.length === 0) return '(no checkable code samples)';
  const lines: string[] = [];
  for (const r of report.results) {
    if (r.status === 'errors') {
      lines.push(`- DOES NOT COMPILE — sample starting \`${r.sample.quote}\`:\n${r.messages.map((m) => `    ${m}`).join('\n')}`);
    } else if (r.status === 'ok') {
      lines.push(`- OK — sample starting \`${r.sample.quote}\``);
    }
  }
  if (report.unavailable.length) lines.push(`(not checked — compiler not installed: ${report.unavailable.join(', ')})`);
  return lines.join('\n') || '(no checkable code samples)';
}
