/**
 * Python-backed math verification for book sections.
 *
 * The model transcribes each calculation in a section into a check
 * (expression + the value the book claims). lib/book/math/check_math.py
 * evaluates them with a restricted evaluator (NumPy / SymPy, no eval, no
 * imports, no attribute access) in a separate process with a time limit.
 *
 * Python is found via BOOK_MATH_PYTHON (recommended: a dedicated venv), then
 * `py -3` / `python` / `python3`; it must have numpy and sympy installed.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

import { createLogger } from '@/lib/logger';

const log = createLogger('BookMath');

export interface MathCheck {
  id: string;
  kind: 'value' | 'assert' | 'identity';
  /** Short quote from the section so the editor can find the passage. */
  quote: string;
  /** What is being calculated, in words. */
  description: string;
  expression?: string;
  claimed?: string;
  lhs?: string;
  rhs?: string;
  tolerance?: number;
}

export interface MathResult {
  id: string;
  kind: string;
  ok: boolean | null;
  computed?: number | boolean | string;
  claimedValue?: number;
  tolerance?: number;
  error?: string;
}

const CHECKER = path.join(process.cwd(), 'lib', 'book', 'math', 'check_math.py');

function run(cmd: string, args: string[], input: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? String(error?.message ?? '') });
      },
    );
    child.stdin?.end(input);
  });
}

interface PythonStatus {
  ok: boolean;
  command?: string[];
  versions?: { numpy: string; sympy: string };
  problem?: string;
}

let pythonStatus: Promise<PythonStatus> | null = null;

/** Forget the cached interpreter (after installing Python/packages). */
export function resetMathPython(): void {
  pythonStatus = null;
}

/** Find a Python that can run the checker (numpy + sympy importable). */
export function findMathPython(): Promise<PythonStatus> {
  if (pythonStatus) return pythonStatus;
  pythonStatus = (async () => {
    const configured = process.env.BOOK_MATH_PYTHON?.trim();
    const candidates: string[][] = configured
      ? [[configured]]
      : process.platform === 'win32'
        ? [['py', '-3'], ['python'], ['python3']]
        : [['python3'], ['python']];

    let lastProblem = '';
    for (const candidate of candidates) {
      const [cmd, ...pre] = candidate;
      const result = await run(cmd, [...pre, CHECKER, '--selftest'], '', 30000);
      if (result.code === 0) {
        try {
          const info = JSON.parse(result.stdout) as { ok: boolean; numpy: string; sympy: string };
          if (info.ok) return { ok: true, command: candidate, versions: { numpy: info.numpy, sympy: info.sympy } };
        } catch {
          /* fall through */
        }
      }
      if (result.code !== 127) {
        // Python exists but the self-test failed — almost always missing packages.
        lastProblem = /No module named '?(numpy|sympy)/.exec(result.stderr)
          ? `"${candidate.join(' ')}" works but is missing ${/No module named '?(\w+)/.exec(result.stderr)?.[1]}`
          : `"${candidate.join(' ')}" failed: ${result.stderr.trim().split('\n').slice(-1)[0] || 'unknown error'}`;
        if (configured) break;
      } else if (configured) {
        lastProblem = `BOOK_MATH_PYTHON is "${configured}", which could not be run`;
      }
    }
    return { ok: false, problem: lastProblem || 'No Python interpreter was found' };
  })();
  return pythonStatus;
}

/** Evaluate checks with the Python checker. Returns null if Python is unavailable. */
export async function runMathChecks(checks: MathCheck[]): Promise<MathResult[] | null> {
  if (checks.length === 0) return [];
  const python = await findMathPython();
  if (!python.ok || !python.command) {
    log.warn(`Math verification skipped: ${python.problem}`);
    return null;
  }
  const [cmd, ...pre] = python.command;
  const result = await run(cmd, [...pre, CHECKER], JSON.stringify(checks), 120000);
  if (result.code !== 0) {
    log.warn(`Math checker failed: ${result.stderr.slice(-500)}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout) as MathResult[];
  } catch {
    log.warn('Math checker returned invalid JSON');
    return null;
  }
}

const fmt = (x: unknown) =>
  typeof x === 'number' ? (Math.abs(x) >= 1e6 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(4) : `${+x.toFixed(6)}`) : String(x);

/** Human-readable verification report for the technical editor. */
export function formatMathResults(checks: MathCheck[], results: MathResult[]): string {
  const byId = new Map(results.map((r) => [r.id, r]));
  const lines: string[] = [];
  for (const check of checks) {
    const r = byId.get(check.id);
    if (!r) continue;
    const where = `"${check.quote}"`;
    if (r.ok === true) {
      lines.push(`- OK — ${check.description} (${where})`);
    } else if (r.ok === false) {
      if (check.kind === 'value') {
        lines.push(
          `- WRONG — ${check.description} (${where}): the book says ${check.claimed}, but ${check.expression} = ${fmt(r.computed)}.`,
        );
      } else if (check.kind === 'assert') {
        lines.push(`- WRONG — ${check.description} (${where}): the condition ${check.expression} is false, so the statement cannot be true.`);
      } else {
        lines.push(`- WRONG — ${check.description} (${where}): ${check.lhs} ≠ ${check.rhs} (difference simplifies to ${r.computed}).`);
      }
    } else {
      lines.push(`- NOT CHECKED — ${check.description} (${where}): ${r.error}`);
    }
  }
  return lines.join('\n') || '(no calculations found)';
}
