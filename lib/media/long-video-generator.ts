import { finalizeLongVideoJob, runNextLongVideoJobSegment } from './long-video-worker';
import { loadLongVideoJob } from './long-video-job-store';
import type { LongVideoJob } from './long-video-job';
import type { VideoGenerationConfig } from './types';

export async function generateLongVideoJob(
  jobId: string,
  config: VideoGenerationConfig,
): Promise<LongVideoJob> {
  while (true) {
    const job = await loadLongVideoJob(jobId);

    if (!job) {
      throw new Error(`Long video job not found: ${jobId}`);
    }

    if (job.status === 'completed') {
      return job;
    }

    if (job.status === 'failed') {
      throw new Error(job.error || `Long video job failed: ${jobId}`);
    }

    const allSegmentsCompleted = job.segments.every((segment) => segment.status === 'completed');

    if (allSegmentsCompleted) {
      return finalizeLongVideoJob(jobId);
    }

    const result = await runNextLongVideoJobSegment(jobId, config);

    if (!result) {
      const latestJob = await loadLongVideoJob(jobId);

      if (!latestJob) {
        throw new Error(`Long video job not found: ${jobId}`);
      }

      if (latestJob.status === 'failed') {
        throw new Error(latestJob.error || `Long video job failed: ${jobId}`);
      }

      throw new Error(`Long video generator stopped before job ${jobId} completed`);
    }
  }
}
