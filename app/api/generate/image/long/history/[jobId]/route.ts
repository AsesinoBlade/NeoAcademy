import fs from 'node:fs/promises';

import { NextResponse } from 'next/server';

import {
  getImageJobDirectory,
  loadImageJob,
} from '@/lib/media/image-job-store';

interface RouteContext {
  params: Promise<{
    jobId: string;
  }>;
}

export async function DELETE(
  _request: Request,
  context: RouteContext,
) {
  try {
    const { jobId } =
      await context.params;

    if (
      !/^[A-Za-z0-9_-]+$/.test(jobId)
    ) {
      return NextResponse.json(
        {
          error:
            'Invalid image job ID',
        },
        {
          status: 400,
        },
      );
    }

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

    if (
      job.origin !== 'standalone' ||
      job.stageId
    ) {
      return NextResponse.json(
        {
          error:
            'Classroom-owned image jobs cannot be deleted from standalone image history',
        },
        {
          status: 403,
        },
      );
    }

    if (
      job.status !== 'completed' &&
      job.status !== 'failed'
    ) {
      return NextResponse.json(
        {
          error:
            'Active image jobs cannot be deleted',
        },
        {
          status: 409,
        },
      );
    }

    await fs.rm(
      getImageJobDirectory(jobId),
      {
        recursive: true,
        force: true,
      },
    );

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to delete image job',
      },
      {
        status: 500,
      },
    );
  }
}