import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const KOKORO_CONTAINER = 'neoacademy-kokoro';
const WHISPER_CONTAINER = 'neoacademy-whisper';

const KOKORO_PORT = 8880;
const WHISPER_PORT = 8881;

const DOCKER_STATE_FILE = path.join(os.tmpdir(), 'neoacademy-docker-desktop.json');

interface ManagedDockerState {
  startedAt: number;
}

/*
 * Start/stop coordination shared across route handlers. Next.js may load
 * this module once per route bundle, so the state lives on globalThis.
 *
 * - `lastStartRequestedAt` lets the idle cleanup detect that a classroom
 *   asked for speech while the (slow) cleanup was running, and skip the stop.
 * - `queue` serialises start/stop so a stop can never interleave with a
 *   start that is halfway through bringing the containers up.
 */
interface SpeechLifecycleState {
  lastStartRequestedAt: number;
  queue: Promise<unknown>;
}

const speechLifecycle: SpeechLifecycleState = ((
  globalThis as typeof globalThis & { __neoacademySpeechLifecycle?: SpeechLifecycleState }
).__neoacademySpeechLifecycle ??= { lastStartRequestedAt: 0, queue: Promise.resolve() });

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = speechLifecycle.queue.then(task, task);
  speechLifecycle.queue = run.catch(() => undefined);
  return run;
}

function readManagedDockerState(): ManagedDockerState | null {
  try {
    return JSON.parse(fs.readFileSync(DOCKER_STATE_FILE, 'utf8')) as ManagedDockerState;
  } catch {
    return null;
  }
}

function writeManagedDockerState(): void {
  fs.writeFileSync(
    DOCKER_STATE_FILE,
    JSON.stringify({
      startedAt: Date.now(),
    }),
  );
}

function clearManagedDockerState(): void {
  try {
    fs.unlinkSync(DOCKER_STATE_FILE);
  } catch {
    // Already absent.
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function dockerDesktopIsRunning(): boolean {
  try {
    const output = execFileSync('docker', ['desktop', 'status'], {
      encoding: 'utf8',
      timeout: 5000,
    });

    return /\brunning\b/i.test(output);
  } catch {
    return false;
  }
}

function dockerEngineIsReady(): boolean {
  try {
    execFileSync('docker', ['info'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function checkPort(port: number, timeout = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));

    socket.connect(port, '127.0.0.1');
  });
}

async function checkHttp(url: string, timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHttp(url: string, name: string, timeoutMs = 120000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await checkHttp(url)) {
      return;
    }

    await sleep(1000);
  }

  throw new Error(`${name} did not become HTTP-ready within ${timeoutMs / 1000} seconds`);
}

async function waitForDockerDesktop(shouldBeRunning: boolean, timeoutMs = 120000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (dockerDesktopIsRunning() === shouldBeRunning) {
      return;
    }

    await sleep(1000);
  }

  throw new Error(
    `Docker Desktop did not become ${
      shouldBeRunning ? 'running' : 'stopped'
    } within ${timeoutMs / 1000} seconds`,
  );
}

async function waitForDockerEngine(timeoutMs = 120000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (dockerEngineIsReady()) return;
    await sleep(1000);
  }

  throw new Error(`Docker engine did not become ready within ${timeoutMs / 1000} seconds`);
}

async function waitForPort(port: number, name: string, timeoutMs = 120000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await checkPort(port)) return;
    await sleep(1000);
  }

  throw new Error(
    `${name} did not become ready on port ${port} within ${timeoutMs / 1000} seconds`,
  );
}

async function containerExists(name: string): Promise<boolean> {
  if (!dockerEngineIsReady()) return false;

  try {
    const { stdout } = await execFileAsync('docker', [
      'container',
      'inspect',
      name,
      '--format',
      '{{.Name}}',
    ]);

    return stdout.trim().replace(/^\//, '') === name;
  } catch {
    return false;
  }
}

async function containerIsRunning(name: string): Promise<boolean> {
  if (!dockerEngineIsReady()) return false;

  try {
    const { stdout } = await execFileAsync('docker', [
      'container',
      'inspect',
      name,
      '--format',
      '{{.State.Running}}',
    ]);

    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function ensureContainer(name: string): Promise<void> {
  if (!(await containerExists(name))) {
    throw new Error(`Required Docker container "${name}" does not exist`);
  }

  if (!(await containerIsRunning(name))) {
    await execFileAsync('docker', ['start', name]);
  }
}

export async function getLocalSpeechServicesStatus() {
  const dockerDesktopRunning = dockerDesktopIsRunning();
  const dockerEngineReady = dockerEngineIsReady();
  const dockerDesktopManaged = !!readManagedDockerState();
  if (!dockerEngineReady) {
    return {
      dockerDesktopRunning,
      dockerDesktopManaged,
      dockerEngineReady: false,
      kokoroRunning: false,
      whisperRunning: false,
      kokoroHealthy: false,
      whisperHealthy: false,
    };
  }

  const [kokoroRunning, whisperRunning, kokoroHealthy, whisperHealthy] = await Promise.all([
    containerIsRunning(KOKORO_CONTAINER),
    containerIsRunning(WHISPER_CONTAINER),
    checkHttp(`http://127.0.0.1:${KOKORO_PORT}/v1/models`),
    checkHttp(`http://127.0.0.1:${WHISPER_PORT}/v1/models`),
  ]);

  return {
    dockerDesktopRunning,
    dockerDesktopManaged,
    dockerEngineReady: true,
    kokoroRunning,
    whisperRunning,
    kokoroHealthy,
    whisperHealthy,
  };
}

export async function startLocalSpeechServices() {
  speechLifecycle.lastStartRequestedAt = Date.now();
  return runExclusive(startLocalSpeechServicesUnlocked);
}

/**
 * Stop speech for idle cleanup — unless something (a classroom, live Q&A)
 * requested speech after `cleanupStartedAt`. The idle cleanup takes tens of
 * seconds, and the user can open a classroom while it is still running.
 */
export async function stopLocalSpeechServicesIfIdle(cleanupStartedAt: number) {
  return runExclusive(async () => {
    if (speechLifecycle.lastStartRequestedAt >= cleanupStartedAt) {
      return {
        success: true,
        stopped: false,
        reason: 'speech-requested-during-cleanup',
      };
    }
    return stopLocalSpeechServicesUnlocked();
  });
}

/**
 * True when `baseUrl` points at the Kokoro container this module manages:
 * the Kokoro port on loopback or on one of this machine's own IP addresses
 * (e.g. TTS_OPENAI_BASE_URL=http://192.168.x.x:8880/v1 on the same PC).
 * A Kokoro running on another machine is not ours to restart.
 */
export function isManagedLocalTtsUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (Number(url.port) !== KOKORO_PORT) return false;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;

  const ownAddresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface): iface is os.NetworkInterfaceInfo => !!iface)
    .map((iface) => iface.address);
  return ownAddresses.includes(host);
}

/** True when the Kokoro TTS endpoint answers. Cheap; used before retrying TTS. */
export async function isLocalTtsHealthy(): Promise<boolean> {
  return checkHttp(`http://127.0.0.1:${KOKORO_PORT}/v1/models`);
}

async function startLocalSpeechServicesUnlocked() {
  // The Docker engine is the authoritative readiness check. On some Windows /
  // Docker Desktop versions, `docker desktop status` may report "stopped" even
  // while the Linux engine is fully reachable through `docker info`.
  //
  // If the engine already works, do not waste 120 seconds waiting for the
  // Desktop CLI status to change — proceed directly to the speech containers.
  if (!dockerEngineIsReady()) {
    if (!dockerDesktopIsRunning()) {
      await execFileAsync('docker', ['desktop', 'start']);
      await waitForDockerEngine();
      writeManagedDockerState();
    } else {
      // Desktop reports running but the engine is not ready yet.
      await waitForDockerEngine();

      if (!readManagedDockerState()) {
        // Docker was started outside NeoAcademy, so do not claim ownership.
        clearManagedDockerState();
      }
    }
  }

  await ensureContainer(KOKORO_CONTAINER);
  await ensureContainer(WHISPER_CONTAINER);

  await Promise.all([
    waitForHttp(`http://127.0.0.1:${KOKORO_PORT}/v1/models`, 'Kokoro TTS'),
    waitForHttp(`http://127.0.0.1:${WHISPER_PORT}/v1/models`, 'Whisper ASR'),
  ]);

  return {
    success: true,
    dockerDesktopRunning: dockerDesktopIsRunning(),
    dockerEngineReady: true,
    kokoroHealthy: true,
    whisperHealthy: true,
  };
}

export async function stopLocalSpeechServices() {
  return runExclusive(stopLocalSpeechServicesUnlocked);
}

async function stopLocalSpeechServicesUnlocked() {
  if (!dockerDesktopIsRunning()) {
    return {
      success: true,
      stopped: false,
      reason: 'docker-desktop-not-running',
    };
  }

  if (dockerEngineIsReady()) {
    for (const name of [KOKORO_CONTAINER, WHISPER_CONTAINER]) {
      if (await containerIsRunning(name)) {
        try {
          await execFileAsync('docker', ['stop', '-t', '10', name]);
        } catch {
          // Continue so Docker Desktop can still be stopped.
        }
      }
    }
  }

  const managedDocker = readManagedDockerState();

  if (managedDocker) {
    await execFileAsync('docker', ['desktop', 'stop']);
    await waitForDockerDesktop(false, 120000);
    clearManagedDockerState();

    return {
      success: true,
      stopped: true,
      dockerDesktopStopped: true,
    };
  }

  return {
    success: true,
    stopped: true,
    dockerDesktopStopped: false,
    reason: 'docker-desktop-not-managed',
  };
}
