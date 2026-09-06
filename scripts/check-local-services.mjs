import net from 'node:net';

const LOCAL_MLX_MODEL = 'z-image-turbo-8bit';

const services = [
  {
    name: 'Ollama',
    host: '127.0.0.1',
    port: 11434,
    hint: 'Start Ollama, then restart NeoAcademy.',
  },
  {
    name: 'Kokoro TTS',
    host: '127.0.0.1',
    port: 8880,
    hint: 'Start Docker Desktop first, then restart NeoAcademy.',
  },
  {
    name: 'Whisper ASR',
    host: '127.0.0.1',
    port: 8881,
    hint: 'Start Docker Desktop first, then restart NeoAcademy.',
  },
  {
    name: 'Local MLX',
    host: '127.0.0.1',
    port: 8001,
    hint: 'Open a separate Terminal window and run: vmlx serve "$HOME/.mlxstudio/models/image/z-image-turbo-8bit" --port 8001\n  Then restart NeoAcademy.',
    verify: verifyLocalMlx,
  },
];

function checkPort({ host, port }, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function verifyLocalMlx() {
  try {
    const response = await fetch('http://127.0.0.1:8001/v1/models', {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return {
        ok: false,
        detail: `/v1/models returned HTTP ${response.status}`,
      };
    }

    const data = await response.json();
    const models = Array.isArray(data?.data) ? data.data : [];
    const modelFound = models.some((model) => model?.id === LOCAL_MLX_MODEL);

    if (!modelFound) {
      const available = models
        .map((model) => model?.id)
        .filter(Boolean)
        .join(', ');

      return {
        ok: false,
        detail: `Expected model "${LOCAL_MLX_MODEL}" was not found. Available: ${
          available || 'none'
        }`,
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: `Unable to query /v1/models: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

console.log('\nNeoAcademy local-service preflight\n');

let failed = false;

for (const service of services) {
  const portOk = await checkPort(service);

  let verification = { ok: portOk };

  if (portOk && service.verify) {
    verification = await service.verify();
  }

  if (verification.ok) {
    console.log(`✓ ${service.name.padEnd(12)} ${service.host}:${service.port}`);
  } else {
    console.error(`✗ ${service.name.padEnd(12)} ${service.host}:${service.port}`);

    if (verification.detail) {
      console.error(`  ${verification.detail}`);
    }

    console.error(`  ${service.hint}`);
    failed = true;
  }
}

if (failed) {
  console.error('\nERROR: Required local AI services are unavailable.');
  console.error('NeoAcademy development server was not started.\n');
  process.exit(1);
}

console.log('\nAll required local AI services are available.\n');
