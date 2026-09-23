import fs from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

import {
  getLongVideoJobDirectory,
  loadLongVideoJob,
} from '@/lib/media/long-video-job-store';

interface RouteContext {
  params: Promise<{
    jobId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;

    if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
      return NextResponse.json(
        { error: 'Invalid long video job ID' },
        { status: 400 },
      );
    }

    const job = await loadLongVideoJob(jobId);

    if (!job) {
      return NextResponse.json(
        { error: 'Long video job not found' },
        { status: 404 },
      );
    }

    if (job.origin !== 'standalone' || job.stageId) {
      return NextResponse.json(
        { error: 'Classroom-owned video job logs are not available here' },
        { status: 403 },
      );
    }

    if (job.status !== 'completed' && job.status !== 'failed') {
      return NextResponse.json(
        { error: 'Video job is still active' },
        { status: 409 },
      );
    }

    const logPath = path.join(
      getLongVideoJobDirectory(jobId),
      'comfyui.log',
    );

    let logText: string;

    try {
      logText = await fs.readFile(logPath, 'utf8');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return new NextResponse('No log file is available for this job.', {
          status: 404,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
          },
        });
      }

      throw error;
    }

    return new NextResponse(logText, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Failed to read standalone long-video log:', error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to read video job log',
      },
      { status: 500 },
    );
  }
}