import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '@/lib/logger';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3100';
const log = createLogger('LocalComfyUI');

interface ManagedComfyUiState {
  pid: number;
  root: string;
  baseUrl: string;
  startedAt: number;
}

function getStateFile(port: string): string {
  return path.join(os.tmpdir(), `neoacademy-comfyui-${port}.json`);
}

function getConfiguredComfyUi(): {
  root: string;
  pythonPath: string;
  mainPath: string;
  baseUrl: string;
  host: string;
  port: string;
  stateFile: string;
} {
  if (process.platform !== 'win32') {
    throw new Error(
      'Automatic ComfyUI lifecycle management is currently supported only on Windows',
    );
  }

  const root = process.env.COMFYUI_ROOT;

  if (!root) {
    throw new Error('COMFYUI_ROOT is not configured');
  }

  const baseUrl =
    process.env.IMAGE_COMFYUI_BASE_URL || process.env.VIDEO_COMFYUI_BASE_URL || DEFAULT_BASE_URL;

  const url = new URL(baseUrl);

  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('Automatic ComfyUI lifecycle management only supports localhost');
  }

  const host = url.hostname;
  const port = url.port || '3100';

  const pythonPath = path.join(root, 'python_embeded', 'python.exe');
  const mainPath = path.join(root, 'ComfyUI', 'main.py');

  return {
    root,
    pythonPath,
    mainPath,
    host,
    port,
    baseUrl: `${url.protocol}//${host}:${port}`,
    stateFile: getStateFile(port),
  };
}

function readManagedState(stateFile: string): ManagedComfyUiState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as ManagedComfyUiState;
  } catch {
    return null;
  }
}

function writeManagedState(stateFile: string, state: ManagedComfyUiState): void {
  fs.writeFileSync(stateFile, JSON.stringify(state));
}

function clearManagedState(stateFile: string): void {
  try {
    fs.unlinkSync(stateFile);
  } catch {
    // Already absent.
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processLooksLikeManagedComfyUi(state: ManagedComfyUiState): boolean {
  if (!processExists(state.pid)) return false;

  try {
    const command = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${state.pid}").CommandLine`,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    );

    return command.includes('ComfyUI') && command.includes('main.py');
  } catch {
    return false;
  }
}

async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/system_stats`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });

    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(baseUrl: string, timeoutMs = 300000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await checkHealth(baseUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`ComfyUI did not become ready within ${timeoutMs / 1000} seconds`);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return !processExists(pid);
}

export async function getLocalComfyUiStatus() {
  const config = getConfiguredComfyUi();
  const state = readManagedState(config.stateFile);

  const healthy = await checkHealth(config.baseUrl);
  const managed = !!state && processLooksLikeManagedComfyUi(state);

  if (state && !managed) {
    clearManagedState(config.stateFile);
  }

  return {
    healthy,
    managed,
    pid: managed ? state!.pid : undefined,
    root: config.root,
    baseUrl: config.baseUrl,
    host: config.host,
    port: config.port,
  };
}

export async function startLocalComfyUi(options: { logPath?: string } = {}) {
  const config = getConfiguredComfyUi();
  log.info(`Preparing managed ComfyUI at ${config.baseUrl}`);
  const existingState = readManagedState(config.stateFile);

  if (existingState && processLooksLikeManagedComfyUi(existingState)) {
    await waitForHealth(config.baseUrl);

    return {
      success: true,
      alreadyRunning: true,
      managed: true,
      pid: existingState.pid,
    };
  }

  if (existingState) {
    clearManagedState(config.stateFile);
  }

  // If ComfyUI was started manually, use it but do not take ownership of it.
  if (await checkHealth(config.baseUrl)) {
    return {
      success: true,
      alreadyRunning: true,
      managed: false,
    };
  }

  if (!fs.existsSync(config.pythonPath)) {
    throw new Error(`ComfyUI Python executable not found: ${config.pythonPath}`);
  }

  if (!fs.existsSync(config.mainPath)) {
    throw new Error(`ComfyUI main.py not found: ${config.mainPath}`);
  }

  log.info(`Starting managed ComfyUI at ${config.baseUrl}`);

  const logPath = options.logPath
    ? path.resolve(options.logPath)
    : path.join(process.cwd(), 'logs', 'comfyui.log');

  const logDirectory = path.dirname(logPath);

  fs.mkdirSync(logDirectory, { recursive: true });

  const logFd = fs.openSync(logPath, 'a');

  const child = spawn(
    config.pythonPath,
    [
      '-s',
      config.mainPath,
      '--windows-standalone-build',
      '--disable-dynamic-vram',
      '--disable-auto-launch',
      '--listen',
      config.host,
      '--port',
      config.port,
    ],
    {
      cwd: config.root,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: process.env,
    },
  );

  fs.closeSync(logFd);

  if (!child.pid) {
    throw new Error('Failed to start ComfyUI process');
  }

  const state: ManagedComfyUiState = {
    pid: child.pid,
    root: config.root,
    baseUrl: config.baseUrl,
    startedAt: Date.now(),
  };

  child.unref();
  writeManagedState(config.stateFile, state);

  try {
    await waitForHealth(config.baseUrl);
    log.info(`Managed ComfyUI ready at ${config.baseUrl} (pid=${child.pid})`);
  } catch (error) {
    log.error(`Managed ComfyUI failed to become ready at ${config.baseUrl} (pid=${child.pid})`);
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Process may already have exited.
    }

    clearManagedState(config.stateFile);
    throw error;
  }

  return {
    success: true,
    alreadyRunning: false,
    managed: true,
    pid: child.pid,
  };
}

export async function stopLocalComfyUi() {
  const config = getConfiguredComfyUi();
  const state = readManagedState(config.stateFile);

  if (!state) {
    return {
      success: true,
      stopped: false,
      reason: 'not-managed',
    };
  }

  if (!processLooksLikeManagedComfyUi(state)) {
    clearManagedState(config.stateFile);

    return {
      success: true,
      stopped: false,
      reason: 'managed-process-not-running',
    };
  }

  try {
    execFileSync('taskkill.exe', ['/PID', String(state.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    // We'll verify below whether it actually exited.
  }

  const exited = await waitForExit(state.pid, 5000);
  if (exited) {
    log.info(`Managed ComfyUI stopped at ${state.baseUrl} (pid=${state.pid})`);
  } else {
    log.error(`Managed ComfyUI did not stop cleanly at ${state.baseUrl} (pid=${state.pid})`);
  }
  clearManagedState(config.stateFile);

  return {
    success: exited,
    stopped: exited,
  };
}
