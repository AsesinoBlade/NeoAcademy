import { NextResponse } from 'next/server';

import { loadLongVideoJob } from '@/lib/media/long-video-job-store';

interface RouteContext {
  params: Promise<{
    jobId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;

    const job = await loadLongVideoJob(jobId);

    if (!job) {
      return NextResponse.json(
        {
          error: 'Long video job not found',
        },
        {
          status: 404,
        },
      );
    }

    return NextResponse.json({
      id: job.id,
      status: job.status,
      prompt: job.prompt,
      targetDurationSeconds: job.targetDurationSeconds,
      segmentCount: job.segmentCount,
      completedSegments: job.completedSegments,
      currentSegmentIndex: job.currentSegmentIndex,
      segments: job.segments,
      outputUrl:
        job.status === 'completed' && job.outputPath
          ? `/api/generate/video/long/${job.id}/output`
          : undefined,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  } catch (error) {
    console.error('Failed to read long video job:', error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to read long video job',
      },
      {
        status: 500,
      },
    );
  }
}
