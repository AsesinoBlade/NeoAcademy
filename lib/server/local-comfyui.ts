import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
const STATE_FILE = path.join(os.tmpdir(), 'neoacademy-comfyui-8188.json');

interface ManagedComfyUiState {
  pid: number;
  root: string;
  baseUrl: string;
  startedAt: number;
}

function getConfiguredComfyUi(): {
  root: string;
  pythonPath: string;
  mainPath: string;
  baseUrl: string;
} {
  if (process.platform !== 'win32') {
    throw new Error(
      'Automatic ComfyUI lifecycle management is currently supported only on Windows',
    );
  }

  const defaultImageModel = process.env.DEFAULT_IMAGE_MODEL || '';
  const separator = defaultImageModel.indexOf(':');
  const provider = separator >= 0 ? defaultImageModel.slice(0, separator) : '';

  if (provider !== 'comfyui') {
    throw new Error('DEFAULT_IMAGE_MODEL must specify a comfyui model');
  }

  const root = process.env.COMFYUI_ROOT;

  if (!root) {
    throw new Error('COMFYUI_ROOT is not configured');
  }

  const baseUrl = process.env.IMAGE_COMFYUI_BASE_URL || DEFAULT_BASE_URL;
  const url = new URL(baseUrl);

  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('Automatic ComfyUI lifecycle management only supports localhost');
  }

  const pythonPath = path.join(root, 'python_embeded', 'python.exe');
  const mainPath = path.join(root, 'ComfyUI', 'main.py');

  return {
    root,
    pythonPath,
    mainPath,
    baseUrl: `${url.protocol}//${url.hostname}:${url.port || '8188'}`,
  };
}

function readManagedState(): ManagedComfyUiState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as ManagedComfyUiState;
  } catch {
    return null;
  }
}

function writeManagedState(state: ManagedComfyUiState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function clearManagedState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
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
  const state = readManagedState();

  const healthy = await checkHealth(config.baseUrl);
  const managed = !!state && processLooksLikeManagedComfyUi(state);

  if (state && !managed) {
    clearManagedState();
  }

  return {
    healthy,
    managed,
    pid: managed ? state!.pid : undefined,
    root: config.root,
    baseUrl: config.baseUrl,
  };
}

export async function startLocalComfyUi() {
  const config = getConfiguredComfyUi();
  const existingState = readManagedState();

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
    clearManagedState();
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

  const child = spawn(
    config.pythonPath,
    [
      '-s',
      config.mainPath,
      '--windows-standalone-build',
      '--disable-dynamic-vram',
      '--disable-auto-launch',
    ],
    {
      cwd: config.root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    },
  );

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
  writeManagedState(state);

  try {
    await waitForHealth(config.baseUrl);
  } catch (error) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Process may already have exited.
    }

    clearManagedState();
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
  const state = readManagedState();

  if (!state) {
    return {
      success: true,
      stopped: false,
      reason: 'not-managed',
    };
  }

  if (!processLooksLikeManagedComfyUi(state)) {
    clearManagedState();

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

  clearManagedState();

  return {
    success: exited,
    stopped: exited,
  };
}
