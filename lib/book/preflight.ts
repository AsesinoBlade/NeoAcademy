/**
 * Preflight checks for ebook generation.
 *
 * Run before generation starts ("start": packages, PDF browser, ComfyUI,
 * web search) and again once the book's project is planned ("project":
 * the build tools and toolchain its build commands need). Every problem
 * comes with exactly what is missing and the steps to fix it, so the user
 * can fix it and continue instead of finding out hours later.
 */
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '@/lib/logger';
import { findPdfBrowser } from './pdf';
import type { ProjectSpec } from './project';
import { resetReferenceToolCaches } from './references';
import { resetVerifyToolCaches, splitArgs, toolAvailable } from './verify';

const log = createLogger('BookPreflight');

export interface PreflightCheck {
  id: string;
  label: string;
  status: 'ok' | 'missing' | 'warning';
  /** Blocking: the book cannot be produced without it. Otherwise the book can
   *  continue with a feature degraded (e.g. no build verification). */
  blocking: boolean;
  detail: string;
  /** Exact steps to fix it (commands are shown as code). */
  fix?: string[];
  /** What happens if the user continues without fixing it. */
  ifIgnored?: string;
}

export interface PreflightResult {
  stage: 'start' | 'project';
  checks: PreflightCheck[];
  blocking: boolean;
  issues: number;
}

const isWindows = process.platform === 'win32';
const RESTART_NOTE = 'Then click "Check again" (no restart needed).';

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0;
      resolve({ code, output: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

/**
 * Windows: pick up PATH changes made after `pnpm dev` started (e.g. CMake just
 * installed), so "Check again" works without restarting the server. Child
 * processes (cmake, make, git) inherit the refreshed PATH.
 */
async function refreshWindowsPath(): Promise<void> {
  if (!isWindows) return;
  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
    process.cwd(),
    15000,
  );
  if (result.code !== 0 || !result.output.trim()) return;
  const current = (process.env.PATH || '').split(';').filter(Boolean);
  const fresh = result.output.trim().split(';').filter(Boolean).map((p) => p.replace(/%([^%]+)%/g, (_m, v) => process.env[v] ?? _m));
  const merged = [...new Set([...fresh, ...current])];
  process.env.PATH = merged.join(';');
  resetVerifyToolCaches();
  resetReferenceToolCaches();
}

// ── Install instructions ─────────────────────────────────────────────────

function installSteps(tool: string): string[] {
  const win: Record<string, string[]> = {
    cmake: ['winget install -e --id Kitware.CMake', 'Or download the Windows x64 installer from https://cmake.org/download/ and tick "Add CMake to the system PATH".'],
    ctest: ['CTest ships with CMake: winget install -e --id Kitware.CMake'],
    cpack: ['CPack ships with CMake: winget install -e --id Kitware.CMake'],
    make: ['winget install -e --id ezwinports.make', 'Or install make from MSYS2 (pacman -S make) or Chocolatey (choco install make).'],
    'mingw32-make': ['winget install -e --id BrechtSanders.WinLibs.POSIX.UCRT  (includes mingw32-make)'],
    ninja: ['winget install -e --id Ninja-build.Ninja'],
    'g++': ['winget install -e --id BrechtSanders.WinLibs.POSIX.UCRT  (GCC for Windows; works with "Unix Makefiles")', 'Check in a NEW terminal: g++ --version'],
    gcc: ['winget install -e --id BrechtSanders.WinLibs.POSIX.UCRT'],
    clang: ['winget install -e --id LLVM.LLVM'],
    'clang++': ['winget install -e --id LLVM.LLVM'],
    git: ['winget install -e --id Git.Git'],
    python: ['winget install -e --id Python.Python.3.13', 'Tick "Add python.exe to PATH" if the installer asks.'],
    node: ['winget install -e --id OpenJS.NodeJS.LTS'],
    npm: ['npm ships with Node.js: winget install -e --id OpenJS.NodeJS.LTS'],
    cargo: ['winget install -e --id Rustlang.Rustup', 'Then run: rustup default stable'],
    go: ['winget install -e --id GoLang.Go'],
    dotnet: ['winget install -e --id Microsoft.DotNet.SDK.8'],
  };
  const unix: Record<string, string[]> = {
    cmake: process.platform === 'darwin' ? ['brew install cmake'] : ['sudo apt install cmake   (or your distribution\'s package manager)'],
    make: process.platform === 'darwin' ? ['xcode-select --install'] : ['sudo apt install build-essential'],
    'g++': process.platform === 'darwin' ? ['xcode-select --install'] : ['sudo apt install build-essential'],
    gcc: process.platform === 'darwin' ? ['xcode-select --install'] : ['sudo apt install build-essential'],
    ninja: process.platform === 'darwin' ? ['brew install ninja'] : ['sudo apt install ninja-build'],
    git: process.platform === 'darwin' ? ['xcode-select --install'] : ['sudo apt install git'],
    python: process.platform === 'darwin' ? ['brew install python'] : ['sudo apt install python3'],
  };
  const table = isWindows ? win : unix;
  return table[tool] ?? [`Install "${tool}" and make sure it is on your PATH (check with: ${tool} --version).`];
}

// ── Start-stage checks ────────────────────────────────────────────────────

function checkPackages(): PreflightCheck {
  const missing = ['marked', 'puppeteer-core', 'mermaid'].filter(
    (pkg) => !existsSync(path.join(process.cwd(), 'node_modules', pkg, 'package.json')),
  );
  return missing.length === 0
    ? { id: 'packages', label: 'Book rendering packages', status: 'ok', blocking: true, detail: 'marked, puppeteer-core and mermaid are installed.' }
    : {
        id: 'packages',
        label: 'Book rendering packages',
        status: 'missing',
        blocking: true,
        detail: `Not installed: ${missing.join(', ')}. They are needed to typeset the book and print the PDF.`,
        fix: [`In the NeoAcademy folder (${process.cwd()}) run: pnpm add ${missing.join(' ')}`, 'Stop and restart pnpm dev (new packages are only loaded at startup), then resume this book from the home page.'],
      };
}

async function checkPdfBrowser(): Promise<PreflightCheck> {
  const configured = process.env.BOOK_PDF_BROWSER_PATH?.trim();
  const browser = findPdfBrowser();
  const base = { id: 'pdf-browser', label: 'PDF browser (Edge / Chrome)', blocking: true };
  if (!browser) {
    return {
      ...base,
      status: 'missing',
      detail: configured
        ? `BOOK_PDF_BROWSER_PATH is set to "${configured}", but no browser exists at that path.`
        : 'No Microsoft Edge or Google Chrome was found. The PDF is printed with one of them.',
      fix: isWindows
        ? ['Edge is part of Windows 11; if it was removed, install Chrome: winget install -e --id Google.Chrome',
           'Or point NeoAcademy at a browser: add to .env.local  BOOK_PDF_BROWSER_PATH=C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
           RESTART_NOTE]
        : ['Install Google Chrome or Chromium, or set BOOK_PDF_BROWSER_PATH in .env.local to its executable.', RESTART_NOTE],
    };
  }
  // Actually launch it headless once: catches policy blocks and broken installs.
  try {
    const puppeteer = (await import('puppeteer-core')).default;
    const instance = await puppeteer.launch({
      executablePath: browser,
      headless: true,
      args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [],
      timeout: 30000,
    });
    await instance.close();
    return { ...base, status: 'ok', detail: `Using ${browser}` };
  } catch (error) {
    return {
      ...base,
      status: 'missing',
      detail: `Found ${browser}, but it could not be started in headless mode: ${error instanceof Error ? error.message : String(error)}`,
      fix: ['Close any stuck browser processes and try again, or install Chrome (winget install -e --id Google.Chrome) and set BOOK_PDF_BROWSER_PATH in .env.local to chrome.exe.', RESTART_NOTE],
    };
  }
}

async function checkComfyUi(): Promise<PreflightCheck> {
  const base = { id: 'comfyui', label: 'ComfyUI (pictures)', blocking: true };
  const url = process.env.IMAGE_COMFYUI_BASE_URL || process.env.VIDEO_COMFYUI_BASE_URL || 'http://127.0.0.1:3100';
  const turnOff = 'Or turn image generation off in Settings to write the book without pictures (charts and diagrams are unaffected).';
  const healthy = await fetch(new URL('/system_stats', url), { signal: AbortSignal.timeout(4000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (healthy) return { ...base, status: 'ok', detail: `ComfyUI is running at ${url}.` };

  if (!isWindows) {
    return { ...base, status: 'missing', detail: `ComfyUI is not reachable at ${url} (automatic start is Windows-only).`, fix: [`Start ComfyUI so it listens on ${url}.`, turnOff, RESTART_NOTE] };
  }
  const root = process.env.COMFYUI_ROOT?.trim();
  if (!root) {
    return { ...base, status: 'missing', detail: 'COMFYUI_ROOT is not set, so NeoAcademy cannot start ComfyUI for the picture phase.', fix: ['Add to .env.local:  COMFYUI_ROOT=C:\\path\\to\\ComfyUI_windows_portable  (the folder that contains python_embeded and ComfyUI)', turnOff, RESTART_NOTE] };
  }
  const missing = [path.join(root, 'python_embeded', 'python.exe'), path.join(root, 'ComfyUI', 'main.py')].filter((p) => !existsSync(p));
  return missing.length
    ? { ...base, status: 'missing', detail: `COMFYUI_ROOT is "${root}", but these are missing: ${missing.join(', ')}.`, fix: ['Set COMFYUI_ROOT in .env.local to the portable ComfyUI folder that contains python_embeded\\python.exe and ComfyUI\\main.py.', turnOff, RESTART_NOTE] }
    : { ...base, status: 'ok', detail: `ComfyUI found at ${root}; it will be started for the picture phase.` };
}

/**
 * SearXNG, checked directly (not through NeoAcademy's search client, which
 * may be in backoff): is it reachable, is JSON enabled, and which of its
 * upstream engines are suspended? A healthy answer also lifts the backoff.
 */
async function checkSearxng(url: string): Promise<PreflightCheck> {
  const base = { id: 'web-search', label: 'Web search (SearXNG)', blocking: false };
  const ifIgnored =
    "Research and fact-check web lookups are skipped; fact-checking still uses the installed tools' own documentation.";
  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/$/, '')}/search?q=${encodeURIComponent('python programming language')}&format=json`, {
      signal: AbortSignal.timeout(20000),
      cache: 'no-store',
    });
  } catch (error) {
    return {
      ...base,
      status: 'warning',
      detail: `SearXNG is not reachable at ${url}: ${error instanceof Error ? error.message : String(error)}.`,
      fix: ['Start the container: docker start searxng', `Check that ${url} opens in a browser${process.env.SEARXNG_URL ? '' : ' (SEARXNG_URL is not set in .env.local; this is the default address)'}.`, RESTART_NOTE],
      ifIgnored,
    };
  }
  if (response.status === 403) {
    return {
      ...base,
      status: 'warning',
      detail: 'SearXNG is running but refuses JSON requests (HTTP 403).',
      fix: ['Add "json" under search: formats: in SearXNG\'s settings.yml, then: docker restart searxng', RESTART_NOTE],
      ifIgnored,
    };
  }
  if (!response.ok) {
    return { ...base, status: 'warning', detail: `SearXNG answered HTTP ${response.status}.`, fix: ['Check the container log: docker logs searxng', RESTART_NOTE], ifIgnored };
  }

  const data = (await response.json().catch(() => ({}))) as {
    results?: Array<{ url?: string; engines?: string[]; engine?: string }>;
    unresponsive_engines?: Array<[string, string]>;
  };
  const results = (data.results ?? []).filter((r) => r.url);
  const suspended = (data.unresponsive_engines ?? []).filter(([, why]) => /suspended|too many|captcha|access denied/i.test(why));
  const answering = [...new Set(results.flatMap((r) => r.engines ?? (r.engine ? [r.engine] : [])))];
  const { resetSearxngBackoff, searxngBackoffStatus } = await import('@/lib/web-search/search');
  const paused = searxngBackoffStatus().pausedUntil;
  const generalEngines = answering.filter((e) => !/wiki/i.test(e));

  if (results.length > 0 && generalEngines.length > 0) {
    resetSearxngBackoff();
    return {
      ...base,
      status: 'ok',
      detail:
        `SearXNG is answering (engines: ${answering.join(', ')}).` +
        (suspended.length ? ` Suspended: ${suspended.map(([n, w]) => `${n} (${w})`).join(', ')}.` : '') +
        (paused ? ' NeoAcademy\'s pause on web lookups has been lifted.' : ''),
    };
  }

  // Running, but its web engines are rate-limited/suspended (only Wikipedia-type
  // engines, or nothing, answering).
  return {
    ...base,
    status: 'warning',
    detail:
      'SearXNG is running, but its web search engines are suspended after being rate-limited by earlier searches' +
      (suspended.length ? `: ${suspended.map(([n, w]) => `${n} (${w})`).join(', ')}` : '') +
      `. ${answering.length ? `Only ${answering.join(', ')} answered, which cannot find technical documentation.` : 'No engine returned results.'}` +
      (paused ? ` NeoAcademy has also paused web lookups until ${new Date(paused).toLocaleTimeString()}.` : ''),
    fix: [
      'Clear the suspensions by restarting SearXNG: docker restart searxng',
      'Optional, to make suspensions shorter in future: in SearXNG\'s settings.yml under search: suspended_times: set SearxEngineTooManyRequests: 600 and SearxEngineCaptcha: 3600',
      'Then click "Check again" — a working result also lifts NeoAcademy\'s pause on web lookups.',
    ],
    ifIgnored,
  };
}

async function checkWebSearch(provider?: string): Promise<PreflightCheck> {
  const searxngUrl = process.env.SEARXNG_URL?.trim() || (provider === 'searxng' ? 'http://127.0.0.1:8888' : '');
  if (provider === 'searxng' || (!provider && searxngUrl)) return checkSearxng(searxngUrl);

  const label = provider ? `Web search (${provider})` : 'Web search';
  const base = { id: 'web-search', label, blocking: false };
  try {
    const { webSearch } = await import('@/lib/web-search/search');
    const results = await Promise.race([
      webSearch('python programming language', {
        maxResults: 2,
        provider: provider as import('@/lib/web-search/search').WebSearchProviderChoice | undefined,
      }),
      new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('timed out after 20s')), 20000)),
    ]);
    if (results.length > 0) return { ...base, status: 'ok', detail: `Web search works (${results.length} test results).` };
    throw new Error('the test search returned no results');
  } catch (error) {
    return {
      ...base,
      status: 'warning',
      detail: `Web search is switched on but does not work: ${error instanceof Error ? error.message : String(error)}.`,
      fix: [
        'Select "SearXNG (self-hosted)" with the globe and set SEARXNG_URL=http://127.0.0.1:8888 in .env.local, or add a Tavily/Brave key in Settings → Web Search.',
        RESTART_NOTE,
      ],
      ifIgnored:
        "Research and fact-check web lookups are skipped; fact-checking still uses the installed tools' own documentation.",
    };
  }
}

/**
 * GPU exclusivity at the start of generation: the LLM is about to load, so
 * ComfyUI must not be resident (there is not enough GPU memory for both).
 * NeoAcademy's own ComfyUI is stopped automatically; one started elsewhere
 * has to be closed by the user.
 */
async function checkGpuFreeForLlm(): Promise<PreflightCheck> {
  const base = { id: 'gpu-comfyui', label: 'GPU free for the LLM', blocking: true };
  const url = process.env.IMAGE_COMFYUI_BASE_URL || process.env.VIDEO_COMFYUI_BASE_URL || 'http://127.0.0.1:3100';
  const healthy = await fetch(new URL('/system_stats', url), { signal: AbortSignal.timeout(3000), cache: 'no-store' })
    .then((r) => r.ok)
    .catch(() => false);
  if (!healthy) return { ...base, status: 'ok', detail: 'ComfyUI is not running, so the GPU is free for the LLM.' };

  try {
    const { getLocalComfyUiStatus, stopLocalComfyUi } = await import('@/lib/server/local-comfyui');
    const status = await getLocalComfyUiStatus();
    if (status.managed) {
      const stopped = await stopLocalComfyUi();
      if (stopped.stopped) {
        return { ...base, status: 'ok', detail: 'Stopped the ComfyUI instance NeoAcademy had left running, so the LLM has the GPU.' };
      }
    }
  } catch {
    // Not Windows / COMFYUI_ROOT not set: treat as an external instance.
  }
  return {
    ...base,
    status: 'missing',
    detail:
      `ComfyUI is running at ${url} and is using GPU memory. The LLM cannot load alongside it ` +
      '(there is not enough GPU memory for both), and NeoAcademy did not start this instance, so it will not close it for you.',
    fix: [
      'Close the ComfyUI window or terminal (or end its python.exe process in Task Manager).',
      'NeoAcademy starts ComfyUI itself when it reaches the picture/video phase, after the LLM has been unloaded.',
      RESTART_NOTE,
    ],
  };
}

/** Python + numpy + sympy for verifying the book's calculations. */
async function checkMathPython(): Promise<PreflightCheck> {
  const { findMathPython, resetMathPython } = await import('./math');
  resetMathPython();
  const base = { id: 'math-python', label: 'Python math checker (numpy + sympy)', blocking: false };
  const status = await findMathPython();
  if (status.ok) {
    return { ...base, status: 'ok', detail: `Using ${status.command!.join(' ')} — numpy ${status.versions!.numpy}, sympy ${status.versions!.sympy}.` };
  }
  const venv = path.join(process.cwd(), '.venv-math');
  return {
    ...base,
    status: 'missing',
    detail: `Calculations in the book are verified with Python, but it is not ready: ${status.problem}.`,
    fix: isWindows
      ? [
          'winget install -e --id Python.Python.3.12   (skip if Python is already installed)',
          `In a NEW terminal, in ${process.cwd()}: py -3 -m venv .venv-math`,
          `.venv-math\\Scripts\\python -m pip install numpy sympy`,
          `Add to .env.local:  BOOK_MATH_PYTHON=${venv}\\Scripts\\python.exe`,
          RESTART_NOTE,
        ]
      : [
          `python3 -m venv ${venv}`,
          `${venv}/bin/python -m pip install numpy sympy`,
          `Add to .env.local:  BOOK_MATH_PYTHON=${venv}/bin/python`,
          RESTART_NOTE,
        ],
    ifIgnored: 'Calculations are reviewed by the model only, without exact verification.',
  };
}

// ── Project-stage checks ───────────────────────────────────────────────────

const looksLikeProgramRun = (program: string) => /^(\.{1,2}[\\/]|build[\\/]|bin[\\/])/.test(program) || /\.(exe|out)$/i.test(program);

async function checkProjectTools(spec: ProjectSpec, factCheck: boolean): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const programs = [...new Set(
    spec.buildCommands
      .flatMap((c) => c.split(/\s*&&\s*/))
      .map((c) => (splitArgs(c)[0] ?? '').toLowerCase())
      .filter((p) => p && !looksLikeProgramRun(p)),
  )];

  for (const program of programs) {
    const available = await toolAvailable(program);
    checks.push(
      available
        ? { id: `tool-${program}`, label: program, status: 'ok', blocking: false, detail: `${program} is on the PATH.` }
        : {
            id: `tool-${program}`,
            label: program,
            status: 'missing',
            blocking: false,
            detail: `"${program}" is not on the PATH. The book's project is built with it${program === 'cmake' && factCheck ? ', and fact-checking reads its built-in documentation' : ''}.`,
            fix: [...installSteps(program), 'Open a NEW terminal and check: ' + `${program} --version`, RESTART_NOTE],
            ifIgnored: 'The book is written without build verification (and without local-documentation fact-checks for this tool).',
          },
    );
  }

  // FetchContent / GoogleTest downloads need git.
  if (/fetchcontent|googletest|gtest|git_repository/i.test(JSON.stringify(spec)) && !(await toolAvailable('git'))) {
    checks.push({
      id: 'tool-git',
      label: 'git',
      status: 'missing',
      blocking: false,
      detail: 'The project downloads dependencies (FetchContent / GoogleTest), which needs git on the PATH.',
      fix: [...installSteps('git'), RESTART_NOTE],
      ifIgnored: 'Build verification will fail at the configure step.',
    });
  }

  // CMake toolchain probe: configure + build a hello-world with the book's generator.
  if (programs.includes('cmake') && (await toolAvailable('cmake'))) {
    checks.push(await probeCMakeToolchain(spec));
  }
  return checks;
}

async function probeCMakeToolchain(spec: ProjectSpec): Promise<PreflightCheck> {
  const configure = spec.buildCommands.find((c) => /^cmake\s/.test(c.trim()) && !/--build|--install/.test(c));
  const argv = configure ? splitArgs(configure) : [];
  const gIndex = argv.findIndex((a) => a === '-G' || (a.startsWith('-G') && a.length > 2));
  const generator = gIndex < 0 ? '' : argv[gIndex] === '-G' ? argv[gIndex + 1] ?? '' : argv[gIndex].slice(2);
  const languages = /\bc\b(?!\+\+)/i.test(spec.language) && !/c\+\+|cpp/i.test(spec.language) ? 'C' : 'CXX';
  const base = { id: 'cmake-toolchain', label: `C++ toolchain${generator ? ` for "${generator}"` : ''}`, blocking: false };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neoacademy-probe-'));
  try {
    const source = languages === 'C' ? 'main.c' : 'main.cpp';
    await fs.writeFile(path.join(dir, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.16)\nproject(probe LANGUAGES ${languages})\nadd_executable(probe ${source})\n`);
    await fs.writeFile(path.join(dir, source), languages === 'C' ? 'int main(void) { return 0; }\n' : '#include <iostream>\nint main() { std::cout << "ok"; }\n');
    const conf = await run('cmake', ['-S', '.', '-B', 'build', ...(generator ? ['-G', generator] : [])], dir, 120000);
    const build = conf.code === 0 ? await run('cmake', ['--build', 'build'], dir, 180000) : null;
    if (conf.code === 0 && build?.code === 0) {
      const compiler = conf.output.match(/compiler identification is ([^\n]+)/)?.[1]?.trim();
      return { ...base, status: 'ok', detail: `A test project configured and built${compiler ? ` with ${compiler}` : ''}.` };
    }

    const output = (build?.output || conf.output).slice(-1500);
    const noMake = /CMAKE_MAKE_PROGRAM is not set|could not find.*make|Running\s+'?nmake|unable to find a build program/i.test(output);
    const noCompiler =
      /No CMAKE_(CXX|C)_COMPILER could be found|is not a full path to an existing compiler tool|compiler identification is unknown|Could not find the compiler specified|CMAKE_(CXX|C)_COMPILER not set|is not able to compile a simple test program/i.test(
        output,
      );
    const badCompilerEnv = output.match(/Could not find the compiler specified in the environment variable (CXX|CC):\s*([^\n]+)/);
    const noVs = /Visual Studio[^\n]*could not find any instance/i.test(output);

    let fix: string[];
    let detail: string;
    if (noMake) {
      const program = /ninja/i.test(generator) ? 'ninja' : 'make';
      detail = `CMake cannot use the "${generator || 'default'}" generator because its build program (${program}) is missing.`;
      fix =
        program === 'make' && isWindows
          ? ['winget install -e --id ezwinports.make', 'A compiler for "Unix Makefiles" on Windows: winget install -e --id BrechtSanders.WinLibs.POSIX.UCRT', 'Open a NEW terminal and check: make --version and g++ --version', RESTART_NOTE]
          : [...installSteps(program), `Open a NEW terminal and check: ${program} --version`, RESTART_NOTE];
    } else if (noCompiler && badCompilerEnv) {
      detail = `The ${badCompilerEnv[1]} environment variable points to "${badCompilerEnv[2].trim().replace(/\.$/, '')}", which does not exist, so CMake cannot find the compiler.`;
      fix = [
        isWindows
          ? `Remove or correct ${badCompilerEnv[1]}: System Properties → Environment Variables, or in PowerShell: [Environment]::SetEnvironmentVariable('${badCompilerEnv[1]}', $null, 'User')`
          : `Remove or correct ${badCompilerEnv[1]} in your shell profile (e.g. unset ${badCompilerEnv[1]}).`,
        'Restart pnpm dev from a NEW terminal (environment variables other than PATH are read at startup), then resume.',
      ];
    } else if (noCompiler) {
      detail = 'CMake could not find a working C++ compiler.';
      fix = isWindows
        ? [generator.toLowerCase().includes('makefiles')
            ? 'For "Unix Makefiles": winget install -e --id BrechtSanders.WinLibs.POSIX.UCRT  (GCC), then check g++ --version in a NEW terminal'
            : 'Install Visual Studio Build Tools with "Desktop development with C++": winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"',
           RESTART_NOTE]
        : [...installSteps('g++'), RESTART_NOTE];
    } else if (noVs) {
      detail = 'CMake\'s default Windows generator needs Visual Studio (or Build Tools), which is not installed.';
      fix = ['winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"', RESTART_NOTE];
    } else {
      detail = 'A test C++ project failed to configure or build with CMake.';
      fix = ['Check the output below, fix the toolchain, then click "Check again".'];
    }
    return {
      ...base,
      status: 'missing',
      detail: `${detail}\n\nCMake output (last lines):\n${output.trim()}`,
      fix,
      ifIgnored: 'The book is written without build verification, so its project code is not compiled or tested.',
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function runPreflight(options: {
  stage: 'start' | 'project';
  /** Classes only need the GPU check; ebooks also need the book toolchain. */
  mode?: 'class' | 'ebook';
  spec?: ProjectSpec | null;
  factCheck: boolean;
  webSearch: boolean;
  imagesEnabled: boolean;
  /** Search engine chosen with the globe. */
  webSearchProvider?: string;
}): Promise<PreflightResult> {
  await refreshWindowsPath();
  const checks: PreflightCheck[] = [];

  if (options.stage === 'start') {
    checks.push(await checkGpuFreeForLlm());
    if (options.mode !== 'class') {
      checks.push(checkPackages());
      checks.push(await checkPdfBrowser());
      if (options.imagesEnabled) checks.push(await checkComfyUi());
      if (options.webSearch) checks.push(await checkWebSearch(options.webSearchProvider));
      if (options.factCheck) checks.push(await checkMathPython());
    }
  } else if (options.spec) {
    checks.push(...(await checkProjectTools(options.spec, options.factCheck)));
  }

  const problems = checks.filter((c) => c.status !== 'ok');
  if (problems.length) {
    log.warn(`Preflight (${options.stage}): ${problems.map((c) => `${c.label} ${c.status}`).join(', ')}`);
  }
  return {
    stage: options.stage,
    checks,
    blocking: problems.some((c) => c.blocking && c.status === 'missing'),
    issues: problems.length,
  };
}
