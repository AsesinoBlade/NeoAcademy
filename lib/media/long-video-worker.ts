import type { LongVideoJob } from './long-video-job';
import { getNextLongVideoJobSegment, prepareLongVideoJobForResume } from './long-video-job-resume';
import {
  loadLongVideoJob,
  saveLongVideoJob,
  getLongVideoJobSegmentLastFramePath,
  getLongVideoJobSegmentPath,
  cleanupCompletedLongVideoJob,
} from './long-video-job-store';
import {
  generateWithComfyUiVideo,
  generateWithComfyUiVideoContinuation,
  generateWithComfyUiLtxTextToVideo,
  generateWithComfyUiLtxImageToVideo,
} from './adapters/comfyui-video-adapter';
import { deleteLocalComfyUiAsset } from '../server/local-comfyui-media';
import type { VideoGenerationConfig } from './types';
import { extractLastFrame } from '../server/video-processing';
import { concatenateVideos } from '../server/video-processing';
import { getLongVideoJobFinalOutputPath } from './long-video-job-store';

const MAX_SEGMENT_ATTEMPTS = 3;

export async function claimNextLongVideoJobSegment(jobId: string): Promise<LongVideoJob | null> {
  const job = await loadLongVideoJob(jobId);

  if (!job) {
    throw new Error(`Long video job not found: ${jobId}`);
  }

  const resumedJob = prepareLongVideoJobForResume(job);

  const nextSegment = getNextLongVideoJobSegment(resumedJob);

  if (nextSegment && (nextSegment.attemptCount ?? 0) >= MAX_SEGMENT_ATTEMPTS) {
    const failedJob: LongVideoJob = {
      ...resumedJob,
      status: 'failed',
      currentSegmentIndex: undefined,
      error: `Segment ${nextSegment.index} exceeded the maximum retry count`,
    };

    await saveLongVideoJob(failedJob);

    return null;
  }

  if (!nextSegment) {
    return null;
  }

  const claimedJob: LongVideoJob = {
    ...resumedJob,
    status: 'generating',
    currentSegmentIndex: nextSegment.index,
    segments: resumedJob.segments.map((segment) =>
      segment.index === nextSegment.index
        ? {
            ...segment,
            status: 'generating',
            attemptCount: (segment.attemptCount ?? 0) + 1,
            error: undefined,
          }
        : segment,
    ),
  };

  return saveLongVideoJob(claimedJob);
}

export async function completeLongVideoJobSegment(
  jobId: string,
  segmentIndex: number,
  outputPath: string,
): Promise<LongVideoJob> {
  const job = await loadLongVideoJob(jobId);

  if (!job) {
    throw new Error(`Long video job not found: ${jobId}`);
  }

  const segments = job.segments.map((segment) =>
    segment.index === segmentIndex
      ? {
          ...segment,
          status: 'completed' as const,
          outputPath,
          error: undefined,
        }
      : segment,
  );

  const completedSegments = segments.filter((segment) => segment.status === 'completed').length;

  const updatedJob: LongVideoJob = {
    ...job,
    segments,
    completedSegments,
    currentSegmentIndex: undefined,
    error: undefined,
  };

  return saveLongVideoJob(updatedJob);
}
export async function failLongVideoJobSegment(
  jobId: string,
  segmentIndex: number,
  errorMessage: string,
): Promise<LongVideoJob> {
  const job = await loadLongVideoJob(jobId);

  if (!job) {
    throw new Error(`Long video job not found: ${jobId}`);
  }

  const segments = job.segments.map((segment) =>
    segment.index === segmentIndex
      ? {
          ...segment,
          status: 'failed' as const,
          error: errorMessage,
        }
      : segment,
  );

  const updatedJob: LongVideoJob = {
    ...job,
    status: 'generating',
    segments,
    currentSegmentIndex: undefined,
    error: undefined,
  };

  return saveLongVideoJob(updatedJob);
}

export async function runNextLongVideoJobSegment(
  jobId: string,
  config: VideoGenerationConfig,
): Promise<LongVideoJob | null> {
  const claimedJob = await claimNextLongVideoJobSegment(jobId);

  if (!claimedJob) {
    return null;
  }

  const segmentIndex = claimedJob.currentSegmentIndex;

  if (segmentIndex === undefined) {
    throw new Error('Claimed long video job has no current segment index');
  }

  const plannedSegment = claimedJob.plan?.segments.find(
    (segment) => segment.index === segmentIndex,
  );

  if (!plannedSegment) {
    const message = `No video plan entry found for segment ${segmentIndex}`;

    await failLongVideoJobSegment(jobId, segmentIndex, message);

    throw new Error(message);
  }

  const outputPath = getLongVideoJobSegmentPath(jobId, segmentIndex);

  const baseUrl = config.baseUrl || process.env.VIDEO_COMFYUI_BASE_URL || 'http://127.0.0.1:3100';

  const cleanupComfyUiAssets = async (assets: {
    output: {
      filename: string;
      subfolder?: string;
      type?: string;
    };
    input?: {
      filename: string;
      subfolder?: string;
      type?: string;
    };
  }) => {
    const cleanupTargets = [assets.output, assets.input].filter(
      (asset): asset is NonNullable<typeof asset> => Boolean(asset),
    );

    await Promise.all(
      cleanupTargets.map((asset) => deleteLocalComfyUiAsset(baseUrl, asset).catch(() => false)),
    );
  };

  try {
    if (claimedJob.origin === 'standalone') {
      const ltxOptions = {
        prompt: plannedSegment.prompt,
        duration: plannedSegment.durationSeconds,
        resolution: '720p' as const,
        aspectRatio: '16:9' as const,
      };

      if (claimedJob.startingImagePath) {
        await generateWithComfyUiLtxImageToVideo(
          config,
          ltxOptions,
          claimedJob.startingImagePath,
          outputPath,
          cleanupComfyUiAssets,
        );
      } else {
        await generateWithComfyUiLtxTextToVideo(
          config,
          ltxOptions,
          outputPath,
          cleanupComfyUiAssets,
        );
      }
    } else if (segmentIndex === 0 && claimedJob.startingImagePath) {
      await generateWithComfyUiVideoContinuation(
        config,
        {
          prompt: plannedSegment.prompt,
        },
        claimedJob.startingImagePath,
        outputPath,
        cleanupComfyUiAssets,
      );
    } else if (plannedSegment.transition === 'continue' && segmentIndex > 0) {
      const previousSegment = claimedJob.segments.find(
        (segment) => segment.index === segmentIndex - 1,
      );

      if (
        !previousSegment ||
        previousSegment.status !== 'completed' ||
        !previousSegment.outputPath
      ) {
        throw new Error(`Previous segment ${segmentIndex - 1} is not available for continuation`);
      }

      const startImagePath = getLongVideoJobSegmentLastFramePath(jobId, segmentIndex - 1);

      await extractLastFrame(previousSegment.outputPath, startImagePath);

      await generateWithComfyUiVideoContinuation(
        config,
        {
          prompt: plannedSegment.prompt,
        },
        startImagePath,
        outputPath,
        cleanupComfyUiAssets,
      );
    } else {
      await generateWithComfyUiVideo(
        config,
        {
          prompt: plannedSegment.prompt,
        },
        outputPath,
        cleanupComfyUiAssets,
      );
    }

    return completeLongVideoJobSegment(jobId, segmentIndex, outputPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await failLongVideoJobSegment(jobId, segmentIndex, message);

    throw error;
  }
}
export async function finalizeLongVideoJob(jobId: string): Promise<LongVideoJob> {
  const job = await loadLongVideoJob(jobId);

  if (!job) {
    throw new Error(`Long video job not found: ${jobId}`);
  }

  const incompleteSegment = job.segments.find(
    (segment) => segment.status !== 'completed' || !segment.outputPath,
  );

  if (incompleteSegment) {
    throw new Error(
      `Cannot finalize long video job because segment ${incompleteSegment.index} is not completed`,
    );
  }

  const assemblingJob = await saveLongVideoJob({
    ...job,
    status: 'assembling',
    currentSegmentIndex: undefined,
    error: undefined,
  });

  const outputPath = getLongVideoJobFinalOutputPath(jobId);

  try {
    const completedSegmentPaths = assemblingJob.segments
      .sort((a, b) => a.index - b.index)
      .map((segment) => segment.outputPath!);

    if (completedSegmentPaths.length === 1) {
      const fs = await import('node:fs/promises');

      await fs.copyFile(completedSegmentPaths[0], outputPath);
    } else {
      await concatenateVideos(completedSegmentPaths, outputPath);
    }

    const completedJob = await saveLongVideoJob({
      ...assemblingJob,
      status: 'completed',
      outputPath,
      error: undefined,
    });

    await cleanupCompletedLongVideoJob(jobId);

    return saveLongVideoJob({
      ...completedJob,
      segments: completedJob.segments.map((segment) => ({
        ...segment,
        outputPath: undefined,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await saveLongVideoJob({
      ...assemblingJob,
      status: 'failed',
      error: message,
    });

    throw error;
  }
}
