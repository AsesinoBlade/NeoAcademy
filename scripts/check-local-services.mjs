import net from 'node:net';

const services = [
  {
    name: 'Ollama',
    host: '127.0.0.1',
    port: 11434,
    hint: 'Start Ollama, then restart NeoAcademy.',
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
