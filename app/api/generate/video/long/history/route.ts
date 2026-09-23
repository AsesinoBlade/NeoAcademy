import { NextResponse } from 'next/server';

import { listStandaloneLongVideoHistoryJobs } from '@/lib/media/long-video-job-store';

export async function GET() {
  try {
    const jobs = await listStandaloneLongVideoHistoryJobs();

    return NextResponse.json({
      jobs: jobs.map((job) => ({
        id: job.id,
        prompt: job.prompt,
        enhancedPrompt: job.enhancedPrompt,
        targetDurationSeconds: job.targetDurationSeconds,
        status: job.status,
        error: job.error,
        outputUrl:
          job.status === 'completed'
            ? `/api/generate/video/long/${job.id}/output`
            : undefined,
        logUrl: `/api/generate/video/long/history/${job.id}/log`,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
    });
  } catch (error) {
    console.error('Failed to list standalone long-video history:', error);

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to list standalone long-video history',
      },
      {
        status: 500,
      },
    );
  }
}
