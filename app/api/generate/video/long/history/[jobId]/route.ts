import fs from 'node:fs/promises';

import { NextResponse } from 'next/server';

import { getLongVideoJobDirectory, loadLongVideoJob } from '@/lib/media/long-video-job-store';

interface RouteContext {
  params: Promise<{
    jobId: string;
  }>;
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;

    if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
      return NextResponse.json(
        {
          error: 'Invalid long video job ID',
        },
        {
          status: 400,
        },
      );
    }

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

    if (job.stageId) {
      return NextResponse.json(
        {
          error: 'Classroom-owned video jobs cannot be deleted from standalone video history',
        },
        {
          status: 403,
        },
      );
    }

    if (job.status !== 'completed' && job.status !== 'failed') {
      return NextResponse.json(
        {
          error: 'Active video jobs cannot be deleted',
        },
        {
          status: 409,
        },
      );
    }

    await fs.rm(getLongVideoJobDirectory(jobId), {
      recursive: true,
      force: true,
    });

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    console.error('Failed to delete standalone long-video job:', error);

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to delete standalone long-video job',
      },
      {
        status: 500,
      },
    );
  }
}
