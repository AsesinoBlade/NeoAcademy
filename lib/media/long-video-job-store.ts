import fs from 'node:fs/promises';
import path from 'node:path';

import type { LongVideoJob } from './long-video-job';

const JOBS_ROOT = path.join(process.cwd(), 'data', 'video-jobs');

export function getLongVideoJobDirectory(jobId: string): string {
  return path.join(JOBS_ROOT, jobId);
}

export function getLongVideoJobStartingImagePath(jobId: string, extension: string): string {
  return path.join(getLongVideoJobDirectory(jobId), `starting-image.${extension}`);
}

export function getLongVideoJobSegmentPath(jobId: string, segmentIndex: number): string {
  const filename = `segment-${String(segmentIndex + 1).padStart(3, '0')}.mp4`;

  return path.join(getLongVideoJobDirectory(jobId), filename);
}

function getJobFilePath(jobId: string): string {
  return path.join(getLongVideoJobDirectory(jobId), 'job.json');
}

export async function ensureLongVideoJobDirectory(jobId: string): Promise<string> {
  const directory = getLongVideoJobDirectory(jobId);

  await fs.mkdir(directory, {
    recursive: true,
  });

  return directory;
}

export async function saveLongVideoJob(job: LongVideoJob): Promise<LongVideoJob> {
  await ensureLongVideoJobDirectory(job.id);

  const updatedJob: LongVideoJob = {
    ...job,
    updatedAt: new Date().toISOString(),
  };

  const filePath = getJobFilePath(job.id);
  const tempFilePath = `${filePath}.tmp`;

  await fs.writeFile(tempFilePath, JSON.stringify(updatedJob, null, 2), 'utf8');

  await fs.rename(tempFilePath, filePath);

  return updatedJob;
}

export async function loadLongVideoJob(jobId: string): Promise<LongVideoJob | null> {
  const filePath = getJobFilePath(jobId);

  try {
    const contents = await fs.readFile(filePath, 'utf8');

    return JSON.parse(contents) as LongVideoJob;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function updateLongVideoJob(
  jobId: string,
  changes: Partial<LongVideoJob>,
): Promise<LongVideoJob> {
  const existingJob = await loadLongVideoJob(jobId);

  if (!existingJob) {
    throw new Error(`Long video job not found: ${jobId}`);
  }

  const updatedJob: LongVideoJob = {
    ...existingJob,
    ...changes,
    id: existingJob.id,
    createdAt: existingJob.createdAt,
    updatedAt: new Date().toISOString(),
  };

  return saveLongVideoJob(updatedJob);
}

export function getLongVideoJobSegmentLastFramePath(jobId: string, segmentIndex: number): string {
  const filename = `segment-${String(segmentIndex + 1).padStart(3, '0')}-last.jpg`;

  return path.join(getLongVideoJobDirectory(jobId), filename);
}

export function getLongVideoJobFinalOutputPath(jobId: string): string {
  return path.join(getLongVideoJobDirectory(jobId), 'final.mp4');
}

export async function cleanupCompletedLongVideoJob(jobId: string): Promise<void> {
  const directory = getLongVideoJobDirectory(jobId);

  const entries = await fs.readdir(directory, {
    withFileTypes: true,
  });

  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (/^segment-\d+\.mp4$/i.test(entry.name) || /^segment-\d+-last\.jpg$/i.test(entry.name)),
      )
      .map((entry) => fs.unlink(path.join(directory, entry.name))),
  );
}

export async function deleteLongVideoJobsForStage(
  stageId: string,
): Promise<{ deleted: number; skippedActive: number }> {
  let entries;

  try {
    entries = await fs.readdir(JOBS_ROOT, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
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

    const job = await loadLongVideoJob(entry.name).catch(() => null);

    if (!job || job.stageId !== stageId) {
      continue;
    }

    if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') {
      skippedActive += 1;
      continue;
    }

    await fs.rm(getLongVideoJobDirectory(job.id), {
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

export async function listStandaloneLongVideoHistoryJobs(): Promise<LongVideoJob[]> {
  let entries;

  try {
    entries = await fs.readdir(JOBS_ROOT, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const jobs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => loadLongVideoJob(entry.name).catch(() => null)),
  );

  return jobs
    .filter(
      (job): job is LongVideoJob =>
        job !== null &&
        job.origin === 'standalone' &&
        (
          (job.status === 'completed' && Boolean(job.outputPath)) ||
          job.status === 'failed'
        ),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
