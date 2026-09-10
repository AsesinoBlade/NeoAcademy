import { execFile, execFileSync } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const KOKORO_CONTAINER = 'neoacademy-kokoro';
const WHISPER_CONTAINER = 'neoacademy-whisper';

const KOKORO_PORT = 8880;
const WHISPER_PORT = 8881;

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

  if (!dockerEngineReady) {
    return {
      dockerDesktopRunning,
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
    dockerEngineReady: true,
    kokoroRunning,
    whisperRunning,
    kokoroHealthy,
    whisperHealthy,
  };
}

export async function startLocalSpeechServices() {
  if (!dockerDesktopIsRunning()) {
    await execFileAsync('docker', ['desktop', 'start']);
    await waitForDockerDesktop(true);
  }

  await waitForDockerEngine();

  await ensureContainer(KOKORO_CONTAINER);
  await ensureContainer(WHISPER_CONTAINER);

  await Promise.all([
    waitForHttp(`http://127.0.0.1:${KOKORO_PORT}/v1/models`, 'Kokoro TTS'),
    waitForHttp(`http://127.0.0.1:${WHISPER_PORT}/v1/models`, 'Whisper ASR'),
  ]);

  return {
    success: true,
    dockerDesktopRunning: true,
    dockerEngineReady: true,
    kokoroHealthy: true,
    whisperHealthy: true,
  };
}

export async function stopLocalSpeechServices() {
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

  await execFileAsync('docker', ['desktop', 'stop']);

  await waitForDockerDesktop(false, 120000);

  return {
    success: true,
    stopped: true,
  };
}
