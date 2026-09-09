import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8001';
const STATE_FILE = path.join(os.tmpdir(), 'neoacademy-vmlx-8001.json');

interface ManagedVmlxState {
  pid: number;
  modelId: string;
  modelPath: string;
  baseUrl: string;
  startedAt: number;
}

function getConfiguredModel(): {
  modelId: string;
  modelPath: string;
  baseUrl: string;
  port: number;
} {
  const defaultImageModel = process.env.DEFAULT_IMAGE_MODEL || '';
  const separator = defaultImageModel.indexOf(':');

  const provider = separator >= 0 ? defaultImageModel.slice(0, separator) : '';

  const modelId = separator >= 0 ? defaultImageModel.slice(separator + 1) : '';

  if (provider !== 'local-mlx' || !modelId) {
    throw new Error('DEFAULT_IMAGE_MODEL must specify a local-mlx model');
  }

  const baseUrl = process.env.IMAGE_LOCAL_MLX_BASE_URL || DEFAULT_BASE_URL;

  const url = new URL(baseUrl);

  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('Automatic vMLX lifecycle management only supports localhost');
  }

  const port = Number(url.port || 8001);

  const modelPath =
    process.env.IMAGE_LOCAL_MLX_MODEL_PATH ||
    path.join(os.homedir(), '.mlxstudio', 'models', 'image', modelId);

  return {
    modelId,
    modelPath,
    baseUrl: `${url.protocol}//${url.hostname}:${port}`,
    port,
  };
}

function readManagedState(): ManagedVmlxState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as ManagedVmlxState;
  } catch {
    return null;
  }
}

function writeManagedState(state: ManagedVmlxState): void {
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

function processLooksLikeManagedVmlx(state: ManagedVmlxState): boolean {
  if (!processExists(state.pid)) return false;

  try {
    const command = execFileSync('/bin/ps', ['-p', String(state.pid), '-o', 'command='], {
      encoding: 'utf8',
    });

    return command.includes('vmlx') && command.includes(state.modelPath);
  } catch {
    return false;
  }
}

async function checkHealth(baseUrl: string, modelId: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });

    if (!response.ok) return false;

    const data = await response.json();
    const models = Array.isArray(data?.data) ? data.data : [];

    return models.some((model: { id?: string }) => model?.id === modelId);
  } catch {
    return false;
  }
}

async function waitForHealth(baseUrl: string, modelId: string, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await checkHealth(baseUrl, modelId)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`vMLX did not become ready within ${timeoutMs / 1000} seconds`);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return !processExists(pid);
}

export async function getLocalVmlxStatus() {
  const config = getConfiguredModel();
  const state = readManagedState();

  const healthy = await checkHealth(config.baseUrl, config.modelId);

  const managed = !!state && processLooksLikeManagedVmlx(state);

  if (state && !managed) {
    clearManagedState();
  }

  return {
    healthy,
    managed,
    pid: managed ? state!.pid : undefined,
    modelId: config.modelId,
    modelPath: config.modelPath,
    baseUrl: config.baseUrl,
  };
}

export async function startLocalVmlx() {
  const config = getConfiguredModel();

  const existingState = readManagedState();

  if (existingState && processLooksLikeManagedVmlx(existingState)) {
    await waitForHealth(config.baseUrl, config.modelId);

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

  // Do not take ownership of a manually started vMLX process.
  if (await checkHealth(config.baseUrl, config.modelId)) {
    return {
      success: true,
      alreadyRunning: true,
      managed: false,
    };
  }

  if (!fs.existsSync(config.modelPath)) {
    throw new Error(`Local MLX model path does not exist: ${config.modelPath}`);
  }

  const executable = process.env.VMLX_BIN || 'vmlx';

  const child = spawn(executable, ['serve', config.modelPath, '--port', String(config.port)], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });

  if (!child.pid) {
    throw new Error('Failed to start vMLX process');
  }

  const state: ManagedVmlxState = {
    pid: child.pid,
    modelId: config.modelId,
    modelPath: config.modelPath,
    baseUrl: config.baseUrl,
    startedAt: Date.now(),
  };

  child.unref();
  writeManagedState(state);

  try {
    await waitForHealth(config.baseUrl, config.modelId);
  } catch (error) {
    try {
      process.kill(-child.pid, 'SIGTERM');
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

export async function stopLocalVmlx() {
  const state = readManagedState();

  if (!state) {
    return {
      success: true,
      stopped: false,
      reason: 'not-managed',
    };
  }

  if (!processLooksLikeManagedVmlx(state)) {
    clearManagedState();

    return {
      success: true,
      stopped: false,
      reason: 'managed-process-not-running',
    };
  }

  // The process was spawned detached, so its PID is also its process-group ID.
  // Kill the whole group so Python resource-tracker children exit as well.
  try {
    process.kill(-state.pid, 'SIGTERM');
  } catch {
    process.kill(state.pid, 'SIGTERM');
  }

  let exited = await waitForExit(state.pid, 5000);

  if (!exited) {
    try {
      process.kill(-state.pid, 'SIGKILL');
    } catch {
      try {
        process.kill(state.pid, 'SIGKILL');
      } catch {
        // Process disappeared between checks.
      }
    }

    exited = await waitForExit(state.pid, 3000);
  }

  clearManagedState();

  return {
    success: exited,
    stopped: exited,
  };
}
