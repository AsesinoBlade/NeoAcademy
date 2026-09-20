import { randomUUID } from 'node:crypto';

import { NextRequest } from 'next/server';

import { callLLM } from '@/lib/ai/llm';
import { generateLongVideoPlan } from '@/lib/media/long-video-planner';
import type { LongVideoJob } from '@/lib/media/long-video-job';
import { ensureLongVideoJobDirectory, saveLongVideoJob } from '@/lib/media/long-video-job-store';
import { startLongVideoProcess } from '@/lib/media/long-video-process';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';

const log = createLogger('Long Video API');

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const { prompt, targetDurationSeconds } = body as {
      prompt?: string;
      targetDurationSeconds?: number;
    };

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

    const { model: languageModel, modelInfo, modelString } = resolveModelFromHeaders(req);

    log.info(`Planning ${targetDurationSeconds}s long video [model=${modelString}]`);

    const plan = await generateLongVideoPlan({
      prompt: prompt.trim(),
      targetDurationSeconds,
      model: languageModel,
      maxOutputTokens: modelInfo?.outputWindow,
    });

    const now = new Date().toISOString();
    const jobId = randomUUID();

    const job: LongVideoJob = {
      id: jobId,
      status: 'queued',
      prompt: prompt.trim(),
      targetDurationSeconds,
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

    await ensureLongVideoJobDirectory(jobId);

    const savedJob = await saveLongVideoJob(job);

    startLongVideoProcess(savedJob.id);

    log.info(`Queued long video job ${savedJob.id} with ${savedJob.segmentCount} segments`);

    return apiSuccess(
      {
        jobId: savedJob.id,
        status: savedJob.status,
        targetDurationSeconds: savedJob.targetDurationSeconds,
        segmentCount: savedJob.segmentCount,
      },
      202,
    );
  } catch (error) {
    log.error('Long video generation request failed:', error);

    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
