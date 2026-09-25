import fs from 'node:fs/promises';
import path from 'node:path';

import type { ImageJob } from './image-job';

const JOBS_ROOT = path.join(
  process.cwd(),
  'data',
  'image-jobs',
);

export function getImageJobDirectory(
  jobId: string,
): string {
  return path.join(JOBS_ROOT, jobId);
}

function getImageJobFilePath(
  jobId: string,
): string {
  return path.join(
    getImageJobDirectory(jobId),
    'job.json',
  );
}

export function getImageJobSourcePath(
  jobId: string,
  index: 1 | 2,
  extension: string,
): string {
  return path.join(
    getImageJobDirectory(jobId),
    `source-${index}.${extension}`,
  );
}

export function getImageJobOutputPath(
  jobId: string,
): string {
  return path.join(
    getImageJobDirectory(jobId),
    'output.png',
  );
}

export async function ensureImageJobDirectory(
  jobId: string,
): Promise<string> {
  const directory =
    getImageJobDirectory(jobId);

  await fs.mkdir(directory, {
    recursive: true,
  });

  return directory;
}

export async function saveImageJob(
  job: ImageJob,
): Promise<ImageJob> {
  await ensureImageJobDirectory(job.id);

  const updatedJob: ImageJob = {
    ...job,
    updatedAt: new Date().toISOString(),
  };

  const filePath =
    getImageJobFilePath(job.id);

  const tempFilePath =
    `${filePath}.tmp`;

  await fs.writeFile(
    tempFilePath,
    JSON.stringify(updatedJob, null, 2),
    'utf8',
  );

  await fs.rename(
    tempFilePath,
    filePath,
  );

  return updatedJob;
}

export async function loadImageJob(
  jobId: string,
): Promise<ImageJob | null> {
  try {
    const contents =
      await fs.readFile(
        getImageJobFilePath(jobId),
        'utf8',
      );

    return JSON.parse(contents) as ImageJob;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }

    throw error;
  }
}

export async function updateImageJob(
  jobId: string,
  changes: Partial<ImageJob>,
): Promise<ImageJob> {
  const existing =
    await loadImageJob(jobId);

  if (!existing) {
    throw new Error(
      `Image job not found: ${jobId}`,
    );
  }

  return saveImageJob({
    ...existing,
    ...changes,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteImageJobsForStage(
  stageId: string,
): Promise<{ deleted: number; skippedActive: number }> {
  let entries;

  try {
    entries = await fs.readdir(JOBS_ROOT, {
      withFileTypes: true,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {
        deleted: 0,
        skippedActive: 0,
      };
    }

    throw error;
  }

  let deleted = 0;
  let skippedActive = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const job =
      await loadImageJob(entry.name).catch(() => null);

    if (
      !job ||
      job.origin !== 'classroom' ||
      job.stageId !== stageId
    ) {
      continue;
    }

    if (
      job.status !== 'completed' &&
      job.status !== 'failed' &&
      job.status !== 'cancelled'
    ) {
      skippedActive += 1;
      continue;
    }

    await fs.rm(getImageJobDirectory(job.id), {
      recursive: true,
      force: true,
    });

    deleted += 1;
  }

  return {
    deleted,
    skippedActive,
  };
}
export async function listStandaloneImageHistoryJobs():
Promise<ImageJob[]> {
  let entries;

  try {
    entries = await fs.readdir(
      JOBS_ROOT,
      {
        withFileTypes: true,
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }

    throw error;
  }

  const jobs =
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isDirectory(),
        )
        .map(
          async (entry) =>
            loadImageJob(
              entry.name,
            ).catch(() => null),
        ),
    );

  return jobs
    .filter(
      (job): job is ImageJob =>
        job !== null &&
        job.origin === 'standalone' &&
        (
          (
            job.status === 'completed' &&
            Boolean(job.outputPath)
          ) ||
          job.status === 'failed'
        ),
    )
    .sort(
      (a, b) =>
        Date.parse(b.createdAt) -
        Date.parse(a.createdAt),
    );
}