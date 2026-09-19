import { spawn } from 'node:child_process';

export function startLongVideoProcess(jobId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new Error(`Invalid long video job ID: ${jobId}`);
  }

  const commandProcessor = process.env.ComSpec || 'cmd.exe';

  const command = `pnpm dlx tsx scripts/run-long-video-job.ts ${jobId}`;

  const child = spawn(commandProcessor, ['/d', '/s', '/c', command], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  child.unref();
}
