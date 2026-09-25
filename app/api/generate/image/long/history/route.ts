import { NextResponse } from 'next/server';

import {
  listStandaloneImageHistoryJobs,
} from '@/lib/media/image-job-store';

export async function GET() {
  try {
    const jobs =
      await listStandaloneImageHistoryJobs();

    return NextResponse.json({
      jobs:
        jobs.map((job) => ({
          id: job.id,
          mode: job.mode,
          prompt: job.prompt,
          enhancePrompt:
            job.enhancePrompt === true,
          enhancedPrompt:
            job.enhancedPrompt,
          secondPrompt:
            job.secondPrompt,
          enhanceSecondPrompt:
            job.enhanceSecondPrompt ===
            true,
          enhancedSecondPrompt:
            job.enhancedSecondPrompt,
          width: job.width,
          height: job.height,
          status: job.status,
          error: job.error,
          outputUrl:
            job.status === 'completed'
              ? `/api/generate/image/long/${job.id}/output`
              : undefined,
          logUrl:
            `/api/generate/image/long/history/${job.id}/log`,
          createdAt:
            job.createdAt,
          updatedAt:
            job.updatedAt,
        })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to list image history',
      },
      {
        status: 500,
      },
    );
  }
}