/**
 * Per-book verification plan.
 *
 * After the outline is approved, a planner (the model) decides how THIS
 * book's claims can be checked, for any subject:
 *  - tools: the programs involved (and whether they are installed here);
 *  - docSources: where authoritative reference material comes from — a tool's
 *    own help output, documentation/files bundled with an installed tool, or
 *    official documentation web pages;
 *  - checks: commands that verify the book's code/command samples by fence
 *    language (compile, syntax-check, run headless...);
 *  - versions: the versions the book targets (stated in the book).
 *
 * Nothing the planner proposes runs until the user approves the plan. Commands
 * run without a shell, only programs found on this PC, in a scratch folder.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PlanTool {
  name: string;
  /** Executable name (no path), e.g. "fpc", "blender", "cdb". */
  executable?: string;
  purpose: string;
  /** Official download page / how to install (shown when missing). */
  installHint?: string;
  /** Filled by discovery: absolute path when found on this PC. */
  resolvedPath?: string;
}

export interface PlanDocSource {
  id: string;
  tool: string;
  kind: 'tool-help' | 'local-path' | 'web';
  description: string;
  /** tool-help: argv, e.g. ["fpc", "-h"]. */
  command?: string[];
  /** local-path: path relative to the tool's install folder ({install}/...) or absolute. */
  path?: string;
  /** web: official documentation start page; pages under the same path are fetched. */
  url?: string;
  /** Runs code beyond printing help (e.g. a scripting introspection dump). */
  executesCode?: boolean;
}

export interface PlanCheck {
  id: string;
  label: string;
  /** Code-fence languages this check applies to, lower case: ["pascal", "pas"]. */
  languages: string[];
  /** Scratch file name for the sample, e.g. "sample.pas". */
  fileName: string;
  /** argv with placeholders {file}, {dir}, {fixture:<name>}. */
  command: string[];
  /** Regex a sample must match to be checkable (a complete unit), else it is a fragment. */
  completeWhen?: string;
  /** Regex on output meaning failure even with exit code 0. */
  failureOutput?: string;
  successExitCodes?: number[];
  timeoutSec?: number;
  /** Runs the sample (not just compile/syntax-check): flagged in the approval UI. */
  executesCode: boolean;
}

export interface PlanFixture {
  name: string;
  /** What the user must provide, e.g. "a crash dump (.dmp) from a 64-bit process". */
  description: string;
  /** Filled by the user at approval. */
  path?: string;
}

export interface VerificationPlan {
  createdAt: string;
  subjects: string[];
  versions: Array<{ tool: string; version: string }>;
  tools: PlanTool[];
  docSources: PlanDocSource[];
  checks: PlanCheck[];
  fixtures: PlanFixture[];
  /** User decision: undefined = pending. */
  decision?: {
    approved: boolean;
    at: string;
    /** Fetch official documentation pages from the web (as text only). */
    allowWeb: boolean;
    /** Per-book opt-in: run the book's code on this PC when the sandbox can't (Windows-only tools). */
    allowHostCode: boolean;
  };
  /** Stage 2 result: reference libraries assembled for this book. */
  assembled?: { at: string; libraries: Array<{ tool: string; path: string; files: number; source: string }>; notes: string[] };
}

/** Programs that are never run as a check or help probe. */
const DENIED = new Set([
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bash', 'sh', 'zsh', 'wsl', 'wsl.exe',
  'reg', 'reg.exe', 'del', 'rm', 'rmdir', 'format', 'diskpart', 'curl', 'wget', 'ssh', 'scp', 'ftp',
  'shutdown', 'taskkill', 'net', 'netsh', 'sc', 'schtasks', 'regedit', 'msiexec', 'winget', 'choco', 'sudo', 'su',
  'mshta', 'rundll32', 'cscript', 'wscript', 'certutil', 'bitsadmin', 'start',
]);

export function isDeniedProgram(program: string): boolean {
  return DENIED.has(path.basename(program).toLowerCase());
}

// ── Discovery (no execution) ──────────────────────────────────────────────

const isWindows = process.platform === 'win32';

function pathExtensions(): string[] {
  return isWindows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').toLowerCase().split(';').filter(Boolean) : [''];
}

function searchRoots(): string[] {
  if (!isWindows) return ['/usr/bin', '/usr/local/bin', '/opt', path.join(os.homedir(), '.local', 'bin')];
  const env = process.env;
  return [
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
    env['LOCALAPPDATA'] && path.join(env['LOCALAPPDATA'], 'Programs'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Steam', 'steamapps', 'common'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Windows Kits', '10', 'Debuggers', 'x64'),
    env['ProgramFiles'] && path.join(env['ProgramFiles'], 'Windows Kits', '10', 'Debuggers', 'x64'),
    'C:\\',
  ].filter((p): p is string => !!p && existsSync(p));
}

async function findInDir(dir: string, names: string[], depth: number): Promise<string | null> {
  if (depth < 0) return null;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && names.includes(e.name.toLowerCase())) return path.join(dir, e.name);
  for (const e of entries) {
    if (!e.isDirectory() || /^(\$|windows$|programdata$|users$|system volume)/i.test(e.name)) continue;
    const found = await findInDir(path.join(dir, e.name), names, depth - 1);
    if (found) return found;
  }
  return null;
}

/**
 * Locate an executable without running anything: PATH first, then install
 * folders whose name resembles the tool (e.g. "Blender Foundation", "FPC").
 */
export async function findExecutable(executable: string, toolName = executable): Promise<string | null> {
  if (!executable) return null;
  if (/[\\/]/.test(executable)) return existsSync(executable) ? executable : null;
  const exts = pathExtensions();
  const base = executable.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const names = exts.map((e) => `${base}${e}`).concat(isWindows ? [] : [base]);
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (existsSync(p)) return p;
    }
  }
  // Install folders whose name matches the tool or the executable.
  const keys = [base, ...toolName.toLowerCase().split(/[^a-z0-9]+/).filter((k) => k.length >= 3)];
  for (const root of searchRoots()) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const lower = e.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!keys.some((k) => lower.includes(k.replace(/[^a-z0-9]/g, '')))) continue;
      const found = await findInDir(path.join(root, e.name), names, 4);
      if (found) return found;
    }
    if (root.endsWith('x64')) {
      const found = await findInDir(root, names, 0);
      if (found) return found;
    }
  }
  return null;
}

// ── Validation of the planner's output ────────────────────────────────────

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';

export function sanitisePlan(raw: unknown): Omit<VerificationPlan, 'createdAt'> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
  const str = (v: unknown, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const argv = (v: unknown) =>
    arr<unknown>(v)
      .filter((a): a is string => typeof a === 'string')
      .map((a) => a.slice(0, 500))
      .slice(0, 30);

  const tools = arr<Record<string, unknown>>(r.tools)
    .map((t) => ({
      name: str(t.name, 80),
      executable: str(t.executable, 80) || undefined,
      purpose: str(t.purpose),
      installHint: str(t.installHint) || undefined,
    }))
    .filter((t) => t.name)
    .slice(0, 12);

  const docSources = arr<Record<string, unknown>>(r.docSources)
    .map((d, i) => {
      const kind = d.kind === 'tool-help' || d.kind === 'local-path' || d.kind === 'web' ? d.kind : null;
      if (!kind) return null;
      const source: PlanDocSource = {
        id: `doc-${i + 1}-${slug(str(d.tool, 40))}`,
        tool: str(d.tool, 60).toLowerCase(),
        kind,
        description: str(d.description),
        executesCode: d.executesCode === true,
      };
      if (kind === 'tool-help') source.command = argv(d.command);
      if (kind === 'local-path') source.path = str(d.path, 400);
      if (kind === 'web') source.url = str(d.url, 400);
      if (kind === 'tool-help' && (!source.command?.length || isDeniedProgram(source.command[0]))) return null;
      if (kind === 'web' && !/^https:\/\/[^\s]+$/i.test(source.url ?? '')) return null;
      if (kind === 'local-path' && !source.path) return null;
      return source;
    })
    .filter((d): d is PlanDocSource => !!d && !!d.tool)
    .slice(0, 16);

  const checks = arr<Record<string, unknown>>(r.checks)
    .map((c, i) => {
      const command = argv(c.command);
      const languages = arr<unknown>(c.languages)
        .filter((l): l is string => typeof l === 'string')
        .map((l) => l.toLowerCase().trim())
        .filter(Boolean);
      const fileName = path.basename(str(c.fileName, 80) || 'sample.txt');
      if (!command.length || !languages.length || isDeniedProgram(command[0]) || !command.some((a) => a.includes('{file}') || a.includes('{dir}'))) return null;
      const check: PlanCheck = {
        id: `check-${i + 1}-${slug(languages[0])}`,
        label: str(c.label, 120) || `Check ${languages[0]} samples`,
        languages,
        fileName,
        command,
        completeWhen: str(c.completeWhen, 300) || undefined,
        failureOutput: str(c.failureOutput, 300) || undefined,
        successExitCodes: arr<unknown>(c.successExitCodes).filter((n): n is number => typeof n === 'number').slice(0, 5),
        timeoutSec: typeof c.timeoutSec === 'number' ? Math.min(Math.max(c.timeoutSec, 5), 300) : 60,
        executesCode: c.executesCode === true,
      };
      for (const re of [check.completeWhen, check.failureOutput]) {
        if (re) {
          try {
            new RegExp(re, 'm');
          } catch {
            return null;
          }
        }
      }
      if (!check.successExitCodes?.length) check.successExitCodes = [0];
      return check;
    })
    .filter((c): c is PlanCheck => !!c)
    .slice(0, 10);

  const fixtures = arr<Record<string, unknown>>(r.fixtures)
    .map((f) => ({ name: slug(str(f.name, 40)), description: str(f.description) }))
    .filter((f) => f.name && f.description)
    .slice(0, 5);

  return {
    subjects: arr<unknown>(r.subjects).filter((s): s is string => typeof s === 'string').slice(0, 10),
    versions: arr<Record<string, unknown>>(r.versions)
      .map((v) => ({ tool: str(v.tool, 60), version: str(v.version, 60) }))
      .filter((v) => v.tool && v.version)
      .slice(0, 12),
    tools,
    docSources,
    checks,
    fixtures,
  };
}

/** Discovery: find each tool's executable on this PC (nothing is run). */
export async function discoverTools(plan: Omit<VerificationPlan, 'createdAt'>): Promise<void> {
  const needed = new Map<string, string>();
  for (const t of plan.tools) if (t.executable) needed.set(t.executable.toLowerCase(), t.name);
  for (const c of plan.checks) needed.set(c.command[0].toLowerCase(), needed.get(c.command[0].toLowerCase()) ?? c.command[0]);
  for (const d of plan.docSources) if (d.command?.[0]) needed.set(d.command[0].toLowerCase(), needed.get(d.command[0].toLowerCase()) ?? d.tool);
  const found = new Map<string, string | null>();
  for (const [exe, toolName] of needed) found.set(exe, await findExecutable(exe, toolName));
  for (const t of plan.tools) if (t.executable) t.resolvedPath = found.get(t.executable.toLowerCase()) ?? undefined;
  for (const exe of needed.keys()) {
    if (!plan.tools.some((t) => t.executable?.toLowerCase() === exe)) {
      plan.tools.push({ name: needed.get(exe) ?? exe, executable: exe, purpose: 'used by a verification command', resolvedPath: found.get(exe) ?? undefined });
    }
  }
}

/** The resolved absolute program for an argv, or null if not installed / not allowed. */
export function resolveProgram(plan: VerificationPlan, program: string): string | null {
  if (isDeniedProgram(program)) return null;
  const tool = plan.tools.find((t) => t.executable?.toLowerCase() === program.toLowerCase());
  return tool?.resolvedPath ?? null;
}

/** Substitute {file}, {dir}, {fixture:name}, {install} in an argv. */
export function fillArgs(
  plan: VerificationPlan,
  argv: string[],
  values: { file?: string; dir?: string },
): string[] | null {
  const out: string[] = [];
  for (const a of argv) {
    let v = a.replace(/\{file\}/g, values.file ?? '').replace(/\{dir\}/g, values.dir ?? '');
    const fixtureRefs = [...v.matchAll(/\{fixture:([a-z0-9-]+)\}/g)];
    for (const m of fixtureRefs) {
      const fixture = plan.fixtures.find((f) => f.name === m[1]);
      if (!fixture?.path) return null;
      v = v.replace(m[0], fixture.path);
    }
    out.push(v);
  }
  return out;
}
