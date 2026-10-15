/**
 * Where code runs — the containment rules, in one place.
 *
 *  1. Docker sandbox (default): any program in the sandbox image. No network,
 *     read-only root, no capabilities, CPU/memory/process/time limits, only the
 *     scratch folder mounted (and fixtures, read-only).
 *  2. Dependency downloads: a separate container WITH network that runs no
 *     project code (see deps-prefetch.ts).
 *  3. This PC (Windows-only tools such as cdb or MSVC): only commands that do
 *     not run the book's code (help output, compile/syntax-only checks), unless
 *     the book explicitly allows running code on this PC. The child gets a
 *     scrubbed environment (no API keys or other secrets) and a timeout.
 *  Everything else is skipped, with the reason recorded.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { createLogger } from '@/lib/logger';

const log = createLogger('BookSandbox');

export const SANDBOX_IMAGE = process.env.BOOK_SANDBOX_IMAGE?.trim() || 'neoacademy-sandbox:1';

/** Programs available inside the sandbox image (see docker/sandbox/Dockerfile). */
const SANDBOX_TOOLS = new Set([
  'gcc', 'g++', 'cc', 'c++', 'clang', 'clang++', 'make', 'cmake', 'ctest', 'cpack', 'ninja',
  'python', 'python3', 'pip', 'pip3', 'node', 'npm', 'npx', 'tsc', 'fpc', 'java', 'javac', 'jar', 'git',
  ...(process.env.BOOK_SANDBOX_EXTRA_TOOLS ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
]);

export function inSandboxImage(program: string): boolean {
  return SANDBOX_TOOLS.has(path.basename(program).toLowerCase().replace(/\.(exe|cmd|bat)$/, ''));
}

export interface ExecResult {
  code: number;
  output: string;
  durationMs: number;
  where: 'container' | 'host' | 'skipped';
  reason?: string;
}

function spawn(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; input?: string }): Promise<{ code: number; output: string; durationMs: number; timedOut: boolean }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        const code = !err ? 0 : err.code === 'ENOENT' ? 127 : typeof err.code === 'number' ? err.code : 1;
        resolve({ code, output: `${stdout ?? ''}${stderr ?? ''}${err && !stdout && !stderr ? String(err.message) : ''}`, durationMs: Date.now() - started, timedOut: !!err?.killed });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

// ── Docker availability ───────────────────────────────────────────────────

let sandboxState: Promise<{ ready: boolean; reason?: string }> | null = null;

export function resetSandboxState(): void {
  sandboxState = null;
}

export function sandboxStatus(): Promise<{ ready: boolean; reason?: string }> {
  sandboxState ??= (async () => {
    const version = await spawn('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15000, env: hostEnv() });
    if (version.code === 127) return { ready: false, reason: 'Docker is not installed.' };
    if (version.code !== 0) return { ready: false, reason: 'Docker is installed but not running (start Docker Desktop).' };
    const image = await spawn('docker', ['image', 'inspect', SANDBOX_IMAGE, '--format', '{{.Id}}'], { timeoutMs: 15000, env: hostEnv() });
    if (image.code !== 0) return { ready: false, reason: `The sandbox image ${SANDBOX_IMAGE} has not been built yet.` };
    return { ready: true };
  })();
  return sandboxState;
}

// ── Host environment: no secrets for child processes ────────────────────

const HOST_ENV_ALLOW = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles',
  'CommonProgramFiles(x86)', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'ComSpec',
  // Toolchains
  'INCLUDE', 'LIB', 'LIBPATH', 'VCINSTALLDIR', 'VSINSTALLDIR', 'VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion',
  'JAVA_HOME', 'GHIDRA_INSTALL_DIR', 'BOOK_JAVA_CLASSPATH', 'CMAKE_GENERATOR',
  // POSIX
  'HOME', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER',
];

/** The environment for any process started on this PC: system essentials only. */
export function hostEnv(): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  const lower = new Map(Object.keys(process.env).map((k) => [k.toLowerCase(), k]));
  for (const name of HOST_ENV_ALLOW) {
    const key = lower.get(name.toLowerCase());
    if (key && process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

// ── Execution ─────────────────────────────────────────────────────────────

export interface ExecRequest {
  argv: string[];
  /** Host scratch folder; mounted at /work in the container. */
  work: string;
  /** True if the command runs the book's code (not just help / compile / syntax check). */
  runsCode: boolean;
  timeoutSec?: number;
  /** Absolute path of the program on this PC, when it is a host tool. */
  hostProgram?: string | null;
  /** Per-book opt-in: allow commands that run book code on this PC. */
  allowHostCode?: boolean;
  /** Read-only files to mount: name → host path (container path /fixtures/<name>). */
  fixtures?: Record<string, string>;
  /** Only for dependency downloads: network on, and the command must not run project code. */
  network?: boolean;
  stdin?: string;
  /** Compile/help-only commands may use this PC's tool even when the sandbox has one (e.g. javac with Ghidra's jars). */
  preferHost?: boolean;
}

/** Map a host path inside `work` to its container path. */
export function toContainerPath(work: string, hostPath: string): string {
  const rel = path.relative(work, hostPath).split(path.sep).join('/');
  return rel ? `/work/${rel}` : '/work';
}

export async function runContained(req: ExecRequest): Promise<ExecResult> {
  const program = req.argv[0] ?? '';
  const timeoutMs = (req.timeoutSec ?? 120) * 1000;
  const sandbox = await sandboxStatus();

  const useHost = !!req.preferHost && !req.runsCode && !req.network && !!req.hostProgram;
  if (inSandboxImage(program) && sandbox.ready && !useHost) {
    const name = `neoacademy-${randomBytes(6).toString('hex')}`;
    const args = [
      'run', '--rm', '--name', name,
      '--network', req.network ? 'bridge' : 'none',
      '--memory', '3g', '--cpus', '2', '--pids-limit', '512',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,exec,size=1g',
      '-v', `${req.work}:/work`, '-w', '/work',
      ...Object.entries(req.fixtures ?? {}).flatMap(([n, p]) => ['-v', `${p}:/fixtures/${n}:ro`]),
      ...(req.stdin !== undefined ? ['-i'] : []),
      SANDBOX_IMAGE,
      ...req.argv,
    ];
    const res = await spawn('docker', args, { timeoutMs: timeoutMs + 30000, env: hostEnv(), input: req.stdin });
    if (res.timedOut) await spawn('docker', ['kill', name], { timeoutMs: 15000, env: hostEnv() });
    return { code: res.code, output: res.output, durationMs: res.durationMs, where: 'container', reason: res.timedOut ? 'timed out' : undefined };
  }

  if (req.network) {
    return { code: -1, output: '', durationMs: 0, where: 'skipped', reason: `downloads only happen inside the sandbox (${sandbox.reason ?? `${program} is not in the sandbox image`})` };
  }
  if (!req.hostProgram) {
    const why = inSandboxImage(program)
      ? `the Docker sandbox is not available (${sandbox.reason})`
      : `${program} is not installed on this PC`;
    return { code: -1, output: '', durationMs: 0, where: 'skipped', reason: why };
  }
  if (req.runsCode && !req.allowHostCode) {
    return {
      code: -1,
      output: '',
      durationMs: 0,
      where: 'skipped',
      reason: `${program} only exists on this PC, and running the book's code on this PC is not enabled for this book`,
    };
  }

  // This PC: scrubbed environment, scratch folder, timeout. Fixture placeholders point at the real files.
  // Commands are written with container paths; map /work and /fixtures back to this PC.
  const argv = [req.hostProgram, ...req.argv.slice(1)].map((a) =>
    a
      .replace(/(^|[=:,])\/work(?=\/|$)/g, (_m, pre) => `${pre}${req.work}`)
      .replace(/\/fixtures\/([a-z0-9-]+)/g, (_m, n) => req.fixtures?.[n] ?? _m),
  );
  const res = await spawn(argv[0], argv.slice(1), { cwd: req.work, env: hostEnv(), timeoutMs, input: req.stdin });
  if (res.timedOut) log.warn(`${program} timed out after ${req.timeoutSec ?? 120}s`);
  return { code: res.code, output: res.output, durationMs: res.durationMs, where: 'host', reason: res.timedOut ? 'timed out' : undefined };
}
