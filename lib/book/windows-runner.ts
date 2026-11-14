/**
 * Windows runner: Windows-only checks and builds, run on another PC over SSH
 * (e.g. a Mac generating books, with a Windows PC on the network).
 *
 * Containment on the Windows side:
 *  - a dedicated standard (non-admin) account with no secrets;
 *  - key-based SSH, firewalled to the generating PC;
 *  - commands are sent as a PowerShell argument array of single-quoted
 *    literals (no shell interpretation of anything from a book);
 *  - a fresh scratch folder per job, deleted afterwards;
 *  - the same policy as running on "this PC": help / compile-only by
 *    default, running book code only with the per-book opt-in.
 *
 * Configure in .env.local:
 *   WINDOWS_RUNNER_HOST=neorunner@192.168.1.50
 *   WINDOWS_RUNNER_KEY=/Users/you/.ssh/neorunner        (private key)
 *   WINDOWS_RUNNER_DIR=C:\NeoRunner\work                (optional)
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { createLogger } from '@/lib/logger';

const log = createLogger('WindowsRunner');

export interface RunnerConfig {
  host: string;
  key?: string;
  dir: string;
}

export function runnerConfig(): RunnerConfig | null {
  const host = process.env.WINDOWS_RUNNER_HOST?.trim();
  if (!host) return null;
  return {
    host,
    key: process.env.WINDOWS_RUNNER_KEY?.trim() || undefined,
    dir: (process.env.WINDOWS_RUNNER_DIR?.trim() || 'C:\\NeoRunner\\work').replace(/[\\/]+$/, ''),
  };
}

function sshArgs(cfg: RunnerConfig): string[] {
  return [
    ...(cfg.key ? ['-i', cfg.key] : []),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
}

function spawn(cmd: string, args: string[], timeoutMs: number, input?: Buffer): Promise<{ code: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf-8', windowsHide: true }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
      const code = !err ? 0 : err.code === 'ENOENT' ? 127 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, output: `${stdout ?? ''}${stderr ?? ''}`, timedOut: !!err?.killed });
    });
    if (input) child.stdin?.end(input);
  });
}

/** Pack a folder into a tar archive (bsdtar on macOS/Windows, GNU tar on Linux). */
function packFolder(dir: string, exclude: string[] = []): Promise<Buffer | null> {
  const excludes = exclude.map((e) => `--exclude=./${e.replace(/^\.?\/+/, '').replace(/\/+$/, '')}`);
  return new Promise((resolve) => {
    execFile('tar', ['-cf', '-', ...excludes, '-C', dir, '.'], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : (stdout as unknown as Buffer)),
    );
  });
}

/** A PowerShell single-quoted literal: no interpolation, no expansion. */
export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Run a PowerShell script on the runner, passed as -EncodedCommand (UTF-16LE base64). */
async function runScript(cfg: RunnerConfig, script: string, timeoutMs: number) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawn('ssh', [...sshArgs(cfg), cfg.host, 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], timeoutMs);
}

// ── Availability and program lookup ───────────────────────────────────────

let reachable: Promise<{ ok: boolean; reason?: string }> | null = null;
export function resetRunnerState(): void {
  reachable = null;
  programs.clear();
}

export function runnerStatus(): Promise<{ ok: boolean; reason?: string }> {
  const cfg = runnerConfig();
  if (!cfg) return Promise.resolve({ ok: false, reason: 'No Windows runner is configured (WINDOWS_RUNNER_HOST).' });
  reachable ??= runScript(cfg, `$PSVersionTable.PSVersion.Major; New-Item -ItemType Directory -Force -Path ${psLiteral(cfg.dir)} | Out-Null; 'ready'`, 20000).then(
    (r) =>
      r.code === 0 && /ready/.test(r.output)
        ? { ok: true }
        : { ok: false, reason: r.code === 127 ? 'ssh is not installed on this computer.' : `The Windows runner at ${cfg.host} did not answer: ${r.output.trim().split('\n').slice(-1)[0] || `exit ${r.code}`}` },
  );
  return reachable;
}

const programs = new Map<string, Promise<string | null>>();

/** Find a program on the Windows PC: PATH, then Windows Kits debuggers, then Program Files / Steam folders named like it. */
export function resolveRemoteProgram(name: string): Promise<string | null> {
  const cfg = runnerConfig();
  if (!cfg) return Promise.resolve(null);
  const base = name.replace(/\.(exe|cmd|bat)$/i, '');
  if (!/^[\w.+-]+$/.test(base)) return Promise.resolve(null);
  if (!programs.has(base.toLowerCase())) {
    const script = `
$n = ${psLiteral(base)}
$c = Get-Command "$n.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) { $c.Source; exit 0 }
$roots = @("$env:ProgramFiles", "\${env:ProgramFiles(x86)}", "$env:LOCALAPPDATA\\Programs",
  "\${env:ProgramFiles(x86)}\\Steam\\steamapps\\common",
  "\${env:ProgramFiles(x86)}\\Windows Kits\\10\\Debuggers\\x64", "$env:ProgramFiles\\Windows Kits\\10\\Debuggers\\x64") | Where-Object { $_ -and (Test-Path $_) }
foreach ($r in $roots) {
  $hit = Get-ChildItem -Path $r -Filter "$n.exe" -Recurse -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { $hit.FullName; exit 0 }
}
exit 1`;
    programs.set(
      base.toLowerCase(),
      runScript(cfg, script, 60000).then((r) => (r.code === 0 ? r.output.trim().split(/\r?\n/).pop() || null : null)),
    );
  }
  return programs.get(base.toLowerCase())!;
}

// ── Sessions: one scratch folder per job ──────────────────────────────────

export interface RunnerSession {
  remoteDir: string;
}

/** Upload a local scratch folder to a fresh folder on the runner. */
export async function openSession(localWork: string, exclude: string[] = []): Promise<RunnerSession | null> {
  const cfg = runnerConfig();
  if (!cfg || !(await runnerStatus()).ok) return null;
  const remoteDir = `${cfg.dir}\\${randomBytes(6).toString('hex')}`;
  const mk = await runScript(cfg, `New-Item -ItemType Directory -Force -Path ${psLiteral(remoteDir)} | Out-Null`, 20000);
  if (mk.code !== 0) return null;
  // Stream a tar archive through SSH into Windows' built-in tar.exe (Windows 10/11):
  // no scp path quirks with drive letters.
  const archive = await packFolder(localWork, exclude);
  if (!archive) {
    log.warn('Could not pack the scratch folder for the Windows runner');
    await closeSession({ remoteDir });
    return null;
  }
  const up = await spawn('ssh', [...sshArgs(cfg), cfg.host, 'tar', '-xf', '-', '-C', `"${remoteDir}"`], 15 * 60 * 1000, archive);
  if (up.code !== 0) {
    log.warn(`Upload to the Windows runner failed: ${up.output.slice(-300)}`);
    await closeSession({ remoteDir });
    return null;
  }
  return { remoteDir };
}

export async function closeSession(session: RunnerSession): Promise<void> {
  const cfg = runnerConfig();
  if (!cfg) return;
  await runScript(cfg, `Remove-Item -Recurse -Force -LiteralPath ${psLiteral(session.remoteDir)} -ErrorAction SilentlyContinue`, 60000);
}

/** Read a text file from the session folder (e.g. a CMakeCache.txt). */
export async function readSessionFile(session: RunnerSession, relative: string): Promise<string> {
  const cfg = runnerConfig();
  if (!cfg) return '';
  const p = `${session.remoteDir}\\${relative.replace(/\//g, '\\')}`;
  const r = await runScript(cfg, `if (Test-Path -LiteralPath ${psLiteral(p)}) { Get-Content -Raw -LiteralPath ${psLiteral(p)} }`, 30000);
  return r.code === 0 ? r.output : '';
}

/**
 * Run one program on the runner inside the session folder. argv uses
 * container-style paths (/work/..., /fixtures/<name>), mapped to the session.
 */
export async function runInSession(
  session: RunnerSession,
  program: string,
  args: string[],
  timeoutSec: number,
): Promise<{ code: number; output: string; timedOut: boolean }> {
  const cfg = runnerConfig()!;
  const toWin = (p: string) => p.replace(/\//g, '\\');
  const mapped = args.map((a) =>
    a
      .replace(/(^|[=:,])\/work((?:\/[^\s'"]*)?)/g, (_m, pre: string, rest: string) => `${pre}${session.remoteDir}${toWin(rest)}`)
      .replace(/\/fixtures\/([a-z0-9-]+)/g, (_m, n: string) => `${session.remoteDir}\\_fixtures\\${n}`),
  );
  const script = [
    `Set-Location -LiteralPath ${psLiteral(session.remoteDir)}`,
    `$a = @(${mapped.map(psLiteral).join(', ')})`,
    `& ${psLiteral(program)} @a 2>&1 | ForEach-Object { "$_" }`,
    'exit $LASTEXITCODE',
  ].join('\n');
  return runScript(cfg, script, timeoutSec * 1000 + 30000);
}
