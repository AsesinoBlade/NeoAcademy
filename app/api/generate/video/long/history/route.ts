import { NextResponse } from 'next/server';

import { listStandaloneCompletedLongVideoJobs } from '@/lib/media/long-video-job-store';

export async function GET() {
  try {
    const jobs = await listStandaloneCompletedLongVideoJobs();

    return NextResponse.json({
      jobs: jobs.map((job) => ({
        id: job.id,
        prompt: job.prompt,
        targetDurationSeconds: job.targetDurationSeconds,
        outputUrl: `/api/generate/video/long/${job.id}/output`,
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
