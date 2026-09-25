import fs from 'node:fs/promises';

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
  const { jobId } =
    await context.params;

  const job =
    await loadImageJob(jobId);

  if (
    !job ||
    job.status !== 'completed' ||
    !job.outputPath
  ) {
    return NextResponse.json(
      {
        error:
          'Image output not available',
      },
      {
        status: 404,
      },
    );
  }

  const bytes =
    await fs.readFile(
      job.outputPath,
    );

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      'Content-Type':
        'image/png',

      'Cache-Control':
        'no-store',
    },
  });
}