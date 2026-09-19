import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import type { LongVideoJob } from '@/lib/media/long-video-job';
import type { LongVideoPlan } from '@/lib/media/long-video-plan';
import { saveLongVideoJob } from '@/lib/media/long-video-job-store';
import { startLongVideoProcess } from '@/lib/media/long-video-process';

interface LongVideoRequestBody {
  prompt?: string;
  targetDurationSeconds?: number;
  plan?: LongVideoPlan;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as LongVideoRequestBody;

    const prompt = body.prompt?.trim();
    const targetDurationSeconds = body.targetDurationSeconds;
    const plan = body.plan;

    if (!prompt) {
      return NextResponse.json(
        {
          error: 'Prompt is required',
        },
        {
          status: 400,
        },
      );
    }

    if (
      !targetDurationSeconds ||
      !Number.isFinite(targetDurationSeconds) ||
      targetDurationSeconds <= 0
    ) {
      return NextResponse.json(
        {
          error: 'A valid target duration is required',
        },
        {
          status: 400,
        },
      );
    }

    if (!plan || plan.segments.length === 0) {
      return NextResponse.json(
        {
          error: 'A long video plan is required',
        },
        {
          status: 400,
        },
      );
    }

    if (plan.targetDurationSeconds !== targetDurationSeconds) {
      return NextResponse.json(
        {
          error: 'Plan target duration does not match requested target duration',
        },
        {
          status: 400,
        },
      );
    }

    const plannedDurationSeconds = plan.segments.reduce(
      (total, segment) => total + segment.durationSeconds,
      0,
    );

    if (plannedDurationSeconds !== targetDurationSeconds) {
      return NextResponse.json(
        {
          error: 'Planned segment duration does not match requested target duration',
        },
        {
          status: 400,
        },
      );
    }

    const now = new Date().toISOString();
    const jobId = randomUUID();

    const job: LongVideoJob = {
      id: jobId,
      status: 'queued',
      prompt,
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

    const savedJob = await saveLongVideoJob(job);

    startLongVideoProcess(savedJob.id);

    return NextResponse.json(
      {
        jobId: savedJob.id,
        status: savedJob.status,
        targetDurationSeconds: savedJob.targetDurationSeconds,
        segmentCount: savedJob.segmentCount,
      },
      {
        status: 202,
      },
    );
  } catch (error) {
    console.error('Failed to create long video job:', error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to create long video job',
      },
      {
        status: 500,
      },
    );
  }
}
