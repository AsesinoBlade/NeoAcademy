import net from 'node:net';

const services = [
  { name: 'Ollama', host: '127.0.0.1', port: 11434, hint: 'Start Ollama.' },
  {
    name: 'Kokoro TTS',
    host: '127.0.0.1',
    port: 8880,
    hint: 'Start Docker Desktop and the neoacademy-kokoro container.',
  },
  {
    name: 'Whisper ASR',
    host: '127.0.0.1',
    port: 8881,
    hint: 'Start Docker Desktop and the neoacademy-whisper container.',
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

console.log('\nNeoAcademy local-service preflight\n');

let failed = false;

for (const service of services) {
  const ok = await checkPort(service);

  if (ok) {
    console.log(`✓ ${service.name.padEnd(12)} ${service.host}:${service.port}`);
  } else {
    console.error(`✗ ${service.name.padEnd(12)} ${service.host}:${service.port}`);
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