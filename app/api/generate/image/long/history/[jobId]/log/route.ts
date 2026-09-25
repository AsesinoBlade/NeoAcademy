import fs from 'node:fs/promises';
import path from 'node:path';

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

export async function GET(
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
            'Classroom-owned image job logs are not available here',
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
            'Image job is still active',
        },
        {
          status: 409,
        },
      );
    }

    const logPath =
      path.join(
        getImageJobDirectory(jobId),
        'comfyui.log',
      );

    try {
      const text =
        await fs.readFile(
          logPath,
          'utf8',
        );

      return new NextResponse(
        text,
        {
          status: 200,
          headers: {
            'Content-Type':
              'text/plain; charset=utf-8',

            'Cache-Control':
              'no-store',
          },
        },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return new NextResponse(
          'No log file is available for this job.',
          {
            status: 404,
            headers: {
              'Content-Type':
                'text/plain; charset=utf-8',
            },
          },
        );
      }

      throw error;
    }
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to read image job log',
      },
      {
        status: 500,
      },
    );
  }
}