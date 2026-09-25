import { NextResponse } from 'next/server';

import {
  loadImageJob,
} from '@/lib/media/image-job-store';

interface RouteContext {
  params: Promise<{
    jobId: string;
  }>;
}

export async function GET(
  _request: Request,
  context: RouteContext,
) {
  try {
    const { jobId } =
      await context.params;

    const job =
      await loadImageJob(jobId);

    if (!job) {
      return NextResponse.json(
        {
          error:
            'Image job not found',
        },
        {
          status: 404,
        },
      );
    }

    return NextResponse.json({
      id: job.id,
      status: job.status,
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
      outputUrl:
        job.status === 'completed' &&
        job.outputPath
          ? `/api/generate/image/long/${job.id}/output`
          : undefined,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to read image job',
      },
      {
        status: 500,
      },
    );
  }
}