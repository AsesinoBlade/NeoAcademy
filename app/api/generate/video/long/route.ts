import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { isFfmpegAvailable } from '@/lib/server/video-processing';
import { NextRequest } from 'next/server';
import { getLocalRuntimeCapabilities } from '@/lib/server/local-runtime-profile';
import { generateLongVideoPlan } from '@/lib/media/long-video-planner';
import type { LongVideoJob } from '@/lib/media/long-video-job';
import {
  ensureLongVideoJobDirectory,
  getLongVideoJobStartingImagePath,
  saveLongVideoJob,
} from '@/lib/media/long-video-job-store';
import { startLongVideoProcess } from '@/lib/media/long-video-process';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import {
  DEFAULT_LTX_VIDEO_RESOLUTION,
  isLtxVideoResolutionPreset,
} from '@/lib/media/ltx-video-resolution';

const log = createLogger('Long Video API');

const MAX_STARTING_IMAGE_BYTES = 20 * 1024 * 1024;

function getStartingImageExtension(file: File): string | null {
  switch (file.type.toLowerCase()) {
    case 'image/png':
      return 'png';

    case 'image/jpeg':
      return 'jpg';

    case 'image/webp':
      return 'webp';

    default:
      return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || '';

    let prompt: string | undefined;
    let targetDurationSeconds: number | undefined;
    let startingImage: File | undefined;
    let stageId: string | undefined;
    let elementId: string | undefined;
    let requestedWidth: number | undefined;
    let requestedHeight: number | undefined;

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();

      const promptValue = formData.get('prompt');
      const durationValue = formData.get('targetDurationSeconds');
      const startingImageValue = formData.get('startingImage');

      const stageIdValue = formData.get('stageId');
      const elementIdValue = formData.get('elementId');
      const widthValue = formData.get('width');
      const heightValue = formData.get('height');

      if (typeof stageIdValue === 'string' && stageIdValue.trim()) {
        stageId = stageIdValue.trim();
      }

      if (typeof elementIdValue === 'string' && elementIdValue.trim()) {
        elementId = elementIdValue.trim();
      }

      if (typeof widthValue === 'string' && widthValue.trim()) {
        requestedWidth = Number(widthValue);
      }

      if (typeof heightValue === 'string' && heightValue.trim()) {
        requestedHeight = Number(heightValue);
      }

      if (typeof promptValue === 'string') {
        prompt = promptValue;
      }

      if (typeof durationValue === 'string' && durationValue.trim()) {
        targetDurationSeconds = Number(durationValue);
      }

      if (startingImageValue instanceof File && startingImageValue.size > 0) {
        startingImage = startingImageValue;
      }
    } else {
      const body = await req.json();

      const parsed = body as {
        prompt?: string;
        targetDurationSeconds?: number;
        stageId?: string;
        elementId?: string;
        width?: number;
        height?: number;
      };

      prompt = parsed.prompt;
      targetDurationSeconds = parsed.targetDurationSeconds;
      stageId = parsed.stageId?.trim() || undefined;
      elementId = parsed.elementId?.trim() || undefined;
      requestedWidth = parsed.width;
      requestedHeight = parsed.height;
    }

    if (!prompt?.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'prompt is required');
    }

    if (
      !Number.isFinite(targetDurationSeconds) ||
      !targetDurationSeconds ||
      targetDurationSeconds <= 0
    ) {
      return apiError('INVALID_REQUEST', 400, 'targetDurationSeconds must be greater than zero');
    }

    if (targetDurationSeconds % 5 !== 0) {
      return apiError('INVALID_REQUEST', 400, 'targetDurationSeconds must be divisible by 5');
    }

    const width =
      requestedWidth ?? DEFAULT_LTX_VIDEO_RESOLUTION.width;
    const height =
      requestedHeight ?? DEFAULT_LTX_VIDEO_RESOLUTION.height;

    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      !isLtxVideoResolutionPreset(width, height)
    ) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Unsupported LTX video resolution: ${width}x${height}`,
      );
    }

    let startingImageExtension: string | undefined;

    if (startingImage) {
      if (startingImage.size > MAX_STARTING_IMAGE_BYTES) {
        return apiError('INVALID_REQUEST', 400, 'startingImage must be 20 MB or smaller');
      }

      const extension = getStartingImageExtension(startingImage);

      if (!extension) {
        return apiError('INVALID_REQUEST', 400, 'startingImage must be PNG, JPEG, or WebP');
      }

      startingImageExtension = extension;
    }

    const runtimeCapabilities = getLocalRuntimeCapabilities();

    if (!runtimeCapabilities.video.available) {
      return apiError(
        'GENERATION_FAILED',
        503,
        `Long-video generation is not available for the ${runtimeCapabilities.profile} runtime profile.`,
      );
    }

    if (!(await isFfmpegAvailable())) {
      return apiError(
        'GENERATION_FAILED',
        503,
        'FFmpeg is required for long-video generation but was not found on this machine.',
      );
    }

    let plan: Awaited<ReturnType<typeof generateLongVideoPlan>>;

    if (!stageId) {
      log.info(`Creating single-segment ${targetDurationSeconds}s standalone LTX video plan`);

      plan = {
        targetDurationSeconds,
        segmentDurationSeconds: targetDurationSeconds,
        segments: [
          {
            index: 0,
            durationSeconds: targetDurationSeconds,
            prompt: prompt.trim(),
            transition: 'cut',
          },
        ],
      };
    } else if (targetDurationSeconds === 5) {
      log.info('Creating single-segment 5s classroom video plan without LLM planning');

      plan = {
        targetDurationSeconds: 5,
        segmentDurationSeconds: 5,
        segments: [
          {
            index: 0,
            durationSeconds: 5,
            prompt: prompt.trim(),
            transition: 'cut',
          },
        ],
      };
    } else {
      const { model: languageModel, modelInfo, modelString } = resolveModelFromHeaders(req);

      log.info(`Planning ${targetDurationSeconds}s classroom video [model=${modelString}]`);

      plan = await generateLongVideoPlan({
        prompt: prompt.trim(),
        targetDurationSeconds,
        model: languageModel,
        maxOutputTokens: modelInfo?.outputWindow,
      });
    }

    const now = new Date().toISOString();
    const jobId = randomUUID();

    await ensureLongVideoJobDirectory(jobId);

    let startingImagePath: string | undefined;

    if (startingImage && startingImageExtension) {
      startingImagePath = getLongVideoJobStartingImagePath(jobId, startingImageExtension);

      const bytes = Buffer.from(await startingImage.arrayBuffer());

      await fs.writeFile(startingImagePath, bytes);
    }

    const job: LongVideoJob = {
      id: jobId,
      status: 'queued',
      prompt: prompt.trim(),
      origin: stageId ? 'classroom' : 'standalone',
      stageId,
      elementId,
      targetDurationSeconds,
      width,
      height,
      startingImagePath,
      plan,
      segmentCount: plan.segments.length,
      completedSegments: 0,
      segments: plan.segments.map((segment) => ({
        index: segment.index,
        status: 'pending',
      })),
      createdAt: now,
      updatedAt: now,
    };

    const savedJob = await saveLongVideoJob(job);

    startLongVideoProcess(savedJob.id);

    log.info(`Queued long video job ${savedJob.id} with ${savedJob.segmentCount} segments`);

    return apiSuccess(
      {
        jobId: savedJob.id,
        status: savedJob.status,
        targetDurationSeconds: savedJob.targetDurationSeconds,
        segmentCount: savedJob.segmentCount,
        hasStartingImage: !!savedJob.startingImagePath,
      },
      202,
    );
  } catch (error) {
    log.error('Long video generation request failed:', error);

    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
