import { spawn } from 'node:child_process';
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
      stdio: 'ignore',
      windowsHide: true,
    },
  );

  child.unref();
}