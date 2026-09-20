import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version'], {
      timeout: 5_000,
    });

    return true;
  } catch {
    return false;
  }
}

export async function extractLastFrame(videoPath: string, outputPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  await execFileAsync(
    'ffmpeg',
    ['-y', '-sseof', '-0.1', '-i', videoPath, '-frames:v', '1', '-q:v', '2', outputPath],
    {
      timeout: 60_000,
    },
  );

  return outputPath;
}

export async function concatenateVideos(videoPaths: string[], outputPath: string): Promise<string> {
  if (videoPaths.length === 0) {
    throw new Error('No videos provided for concatenation');
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const listPath = path.join(
    os.tmpdir(),
    `neoacademy-concat-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );

  const escapeConcatPath = (value: string) => value.replace(/'/g, "'\\''");

  const listContents = videoPaths
    .map((videoPath) => `file '${escapeConcatPath(path.resolve(videoPath))}'`)
    .join('\n');

  await fs.writeFile(listPath, listContents, 'utf8');

  try {
    await execFileAsync(
      'ffmpeg',
      ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath],
      {
        timeout: 120_000,
      },
    );
  } finally {
    await fs.unlink(listPath).catch(() => {});
  }

  return outputPath;
}
