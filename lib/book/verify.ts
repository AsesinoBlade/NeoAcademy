/**
 * Build verification for a book's running project.
 *
 * Copies data/books/<id>/project into a scratch folder and runs the project
 * spec's own build commands (configure → build → test). Commands are parsed
 * into argv and executed WITHOUT a shell, only for allowlisted build tools.
 * The finished program itself is never executed (tests run via ctest etc.).
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { bookDir } from './storage';
import { projectDir } from './project';

export interface VerifyStep {
  command: string;
  argv?: string[];
  status: 'passed' | 'failed' | 'skipped';
  exitCode?: number | null;
  durationMs?: number;
  note?: string;
  outputTail?: string;
}

const BUILD_TOOLS = new Set([
  'cmake', 'ctest', 'cpack', 'make', 'mingw32-make', 'nmake', 'ninja', 'meson',
  'gcc', 'g++', 'clang', 'clang++', 'cl', 'cc', 'c++',
  'python', 'python3', 'pip', 'pytest', 'node', 'npm', 'npx', 'tsc',
  'cargo', 'rustc', 'go', 'dotnet', 'javac', 'mvn', 'gradle',
]);

export interface VerifyReport {
  status: 'passed' | 'failed' | 'skipped';
  reason?: string;
  verifiedAt: string;
  toolchain: string[];
  notes: string[];
  steps: VerifyStep[];
  fixRounds: Array<{ round: number; failedCommand: string; summary: string; files: string[] }>;
  fixedFiles: Array<{ path: string; writtenBackTo: string | null }>;
}

export const verifyDir = (bookId: string) => path.join(bookDir(bookId), 'verify');
export const verifyReportPath = (bookId: string) => path.join(verifyDir(bookId), 'report.json');

/** Split a command line into argv, honouring "double" and 'single' quotes. */
export function splitArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken || current) args.push(current);
      current = '';
      hasToken = false;
    } else {
      current += ch;
    }
  }
  if (hasToken || current) args.push(current);
  return args;
}

function run(
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string; durationMs: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        const code = error ? ((error as NodeJS.ErrnoException & { code?: unknown }).code === 'ENOENT' ? 127 : (error as { code?: number }).code ?? 1) : 0;
        resolve({
          code: typeof code === 'number' ? code : 1,
          output: `${stdout ?? ''}${stderr ?? ''}${error && !stdout && !stderr ? String(error.message) : ''}`,
          durationMs: Date.now() - started,
        });
      },
    );
  });
}

const availability = new Map<string, Promise<boolean>>();

/** Forget cached tool lookups (after PATH changes). */
export function resetVerifyToolCaches(): void {
  availability.clear();
}
export function toolAvailable(tool: string): Promise<boolean> {
  if (!availability.has(tool)) {
    const probe = tool === 'cl' ? [tool] : [tool, '--version'];
    availability.set(
      tool,
      run(probe, process.cwd(), 15000).then((r) => r.code !== 127 && r.output.length > 0),
    );
  }
  return availability.get(tool)!;
}

/**
 * Adapt a CMake configure command to the generators available on this PC
 * (e.g. "Unix Makefiles" requested but no make on Windows → Ninja/default).
 */
async function adaptGenerator(argv: string[]): Promise<{ argv: string[]; note?: string; multiConfig: boolean }> {
  const gIndex = argv.findIndex((a) => a === '-G' || a.startsWith('-G'));
  if (argv[0] !== 'cmake' || gIndex < 0) {
    return { argv, multiConfig: false };
  }
  const inline = argv[gIndex].length > 2 && argv[gIndex] !== '-G';
  const generator = inline ? argv[gIndex].slice(2) : argv[gIndex + 1] || '';
  const needs = /makefiles/i.test(generator) ? (/mingw/i.test(generator) ? 'mingw32-make' : 'make') : /ninja/i.test(generator) ? 'ninja' : null;
  if (!needs || (await toolAvailable(needs))) {
    return { argv, multiConfig: /visual studio|xcode|multi-config/i.test(generator) };
  }
  const without = inline ? [...argv.slice(0, gIndex), ...argv.slice(gIndex + 1)] : [...argv.slice(0, gIndex), ...argv.slice(gIndex + 2)];
  if (await toolAvailable('ninja')) {
    return {
      argv: [...without, '-G', 'Ninja'],
      note: `"${generator}" needs ${needs}, which is not installed here — verified with the Ninja generator instead.`,
      multiConfig: false,
    };
  }
  return {
    argv: without,
    note: `"${generator}" needs ${needs}, which is not installed here — verified with CMake's default generator instead.`,
    multiConfig: process.platform === 'win32',
  };
}

const looksLikeProgramRun = (program: string) =>
  /^(\.{1,2}[\\/]|build[\\/]|bin[\\/])/.test(program) || /\.(exe|out)$/i.test(program);

export interface VerifyRunResult {
  passed: boolean;
  steps: VerifyStep[];
  failedStep?: VerifyStep;
  toolchain: string[];
}

/** Test commands (run only in the final verification, not at chapter checkpoints). */
export function isTestCommand(command: string): boolean {
  const program = splitArgs(command)[0] ?? '';
  return /^(ctest|pytest)$/i.test(program) || /\b(test|tests|check)\b/.test(command.split(/\s+/).slice(1).join(' '));
}

/** The file a build command needs before it can run at all. */
export function rootBuildFile(commands: string[]): string | null {
  for (const command of commands) {
    const program = (splitArgs(command)[0] ?? '').toLowerCase();
    if (program === 'cmake' && !command.includes('--build') && !command.includes('--install')) return 'CMakeLists.txt';
    if (program === 'make' || program === 'mingw32-make') return 'Makefile';
    if (program === 'npm' || program === 'npx') return 'package.json';
    if (program === 'cargo') return 'Cargo.toml';
    if (program === 'meson') return 'meson.build';
  }
  return null;
}

/** Copy the project into a fresh workspace and run its build commands. */
export async function runProjectBuild(bookId: string, commands: string[]): Promise<VerifyRunResult> {
  const work = path.join(verifyDir(bookId), 'work');
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  await fs.cp(projectDir(bookId), work, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.index.json',
  });

  const steps: VerifyStep[] = [];
  const toolchain = new Set<string>();
  let multiConfig = false;

  for (const raw of commands.flatMap((c) => c.split(/\s*&&\s*/)).filter((c) => c.trim())) {
    if (/[|<>;`]|\$\(/.test(raw)) {
      steps.push({ command: raw, status: 'skipped', note: 'Not run: contains shell operators.' });
      continue;
    }
    let argv = splitArgs(raw);
    const program = argv[0] ?? '';

    if (looksLikeProgramRun(program)) {
      steps.push({ command: raw, status: 'skipped', note: 'Not run: executes the finished program.' });
      continue;
    }
    if (!BUILD_TOOLS.has(program.toLowerCase())) {
      steps.push({ command: raw, status: 'skipped', note: `Not run: "${program}" is not an allowlisted build tool.` });
      continue;
    }
    if (!(await toolAvailable(program))) {
      steps.push({ command: raw, status: 'skipped', note: `Not run: ${program} is not installed on this computer.` });
      continue;
    }

    let note: string | undefined;
    if (program === 'cmake' && argv.some((a) => a === '-S' || a === '-B' || a === '..' || a === '.')) {
      const adapted = await adaptGenerator(argv);
      argv = adapted.argv;
      note = adapted.note;
      multiConfig = adapted.multiConfig;
    }
    // Multi-config generators (Visual Studio) need a configuration for tests.
    if (program === 'ctest' && multiConfig && !argv.includes('-C') && !argv.includes('--build-config')) {
      argv = [...argv, '-C', 'Debug'];
      note = (note ? `${note} ` : '') + 'Added -C Debug (multi-config generator).';
    }

    const result = await run(argv, work, 15 * 60 * 1000);

    // Multi-config generators (Visual Studio — CMake's default on Windows —
    // Xcode, Ninja Multi-Config) are detected from the generated cache, not
    // from the command line: `cmake -S . -B build` with no -G is multi-config
    // on Windows, and ctest then needs -C <config>.
    if (program === 'cmake' && result.code === 0 && !argv.includes('--build') && !argv.includes('--install')) {
      const bIndex = argv.findIndex((a) => a === '-B' || (a.startsWith('-B') && a.length > 2));
      const buildDir = bIndex < 0 ? '.' : argv[bIndex] === '-B' ? argv[bIndex + 1] ?? '.' : argv[bIndex].slice(2);
      const cache = await fs.readFile(path.join(work, buildDir, 'CMakeCache.txt'), 'utf-8').catch(() => '');
      const generator = cache.match(/^CMAKE_GENERATOR:INTERNAL=(.+)$/m)?.[1]?.trim() ?? '';
      if (generator) {
        multiConfig = /visual studio|xcode|multi-config/i.test(generator);
        toolchain.add(`Generator: ${generator}`);
      }
    }
    // ctest exits 0 when it finds no tests at all (e.g. enable_testing()
    // missing from the top-level CMakeLists.txt) — that is a failure here.
    if (program === 'ctest' && result.code === 0 && /No tests were found/i.test(result.output)) {
      result.code = 1;
      result.output += '\nVERIFICATION: ctest found no tests. The book tells the reader to run the tests, so tests must be registered (enable_testing() in the top-level CMakeLists.txt, add_test(...)).';
    }
    for (const m of result.output.matchAll(/The (?:CXX|C) compiler identification is ([^\n]+)/g)) toolchain.add(m[1].trim());
    const step: VerifyStep = {
      command: raw,
      argv,
      status: result.code === 0 ? 'passed' : 'failed',
      exitCode: result.code,
      durationMs: result.durationMs,
      note,
      outputTail: result.output.slice(-8000),
    };
    steps.push(step);
    if (result.code !== 0) return { passed: false, steps, failedStep: step, toolchain: [...toolchain] };
  }

  const cmakeVersion = (await toolAvailable('cmake'))
    ? (await run(['cmake', '--version'], process.cwd(), 10000)).output.split('\n')[0]
    : '';
  if (cmakeVersion) toolchain.add(cmakeVersion.replace(/^cmake version/i, 'CMake').trim());

  const ran = steps.filter((s) => s.status !== 'skipped');
  return { passed: ran.length > 0 && ran.every((s) => s.status === 'passed'), steps, toolchain: [...toolchain] };
}

/**
 * Replace the code block for `filePath` (the block whose first line is a
 * `File: <path>` header) in a section's Markdown with new file content.
 */
export function replaceFileBlock(markdown: string, filePath: string, newContent: string): string | null {
  const fenceRe = /^([ \t]*)(```[^\n]*)\n([\s\S]*?)\n([ \t]*```[ \t]*)$/gm;
  let replaced = false;
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`File:\\s*\\.?/?${escaped}\\s*(?:\\*\\/|-->)?\\s*$`);
  const out = markdown.replace(fenceRe, (block, indent: string, open: string, body: string, close: string) => {
    const lines = body.split('\n');
    const first = (indent ? lines[0].slice(indent.length) : lines[0]) ?? '';
    if (!header.test(first.trim())) return block;
    replaced = true;
    const content = newContent.replace(/\n$/, '').split('\n');
    // Keep the original header line; the fix may or may not include one.
    const bodyLines = /File:/.test(content[0] ?? '') ? content : [first.trim(), ...content];
    return `${indent}${open}\n${bodyLines.map((l) => (indent ? indent + l : l)).join('\n')}\n${close}`;
  });
  return replaced ? out : null;
}
