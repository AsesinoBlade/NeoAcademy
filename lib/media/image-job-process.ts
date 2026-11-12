import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export function startImageJobProcess(
  jobId: string,
): void {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new Error(
      `Invalid image job ID: ${jobId}`,
    );
  }

  const require = createRequire(
    path.join(
      process.cwd(),
      'package.json',
    ),
  );

  const tsxCliPath =
    require.resolve('tsx/cli');

  const workerScriptPath =
    path.join(
      process.cwd(),
      'scripts',
      'run-image-job.ts',
    );

  // The worker's output goes to data/image-jobs/<jobId>/worker.log, so a job
  // that fails before it starts generating can still be diagnosed.
  const logDir = path.join(process.cwd(), 'data', 'image-jobs', jobId);
  fs.mkdirSync(logDir, { recursive: true });
  const logFd = fs.openSync(path.join(logDir, 'worker.log'), 'a');

  const child = spawn(
    process.execPath,
    [
      tsxCliPath,
      workerScriptPath,
      jobId,
    ],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    },
  );
  fs.closeSync(logFd);

  child.unref();
}