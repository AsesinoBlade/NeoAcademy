import { NextResponse } from 'next/server';

import {
  loadLongVideoJob,
  saveLongVideoJob,
} from '@/lib/media/long-video-job-store';

interface RouteContext {
  params: Promise<{
    jobId: string;
  }>;
}

export async function POST(_request: Request, context: RouteContext) {
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

    if (
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      return NextResponse.json({
        success: true,
        status: job.status,
      });
    }

    const cancelledJob = await saveLongVideoJob({
      ...job,
      status: 'cancelled',
      currentSegmentIndex: undefined,
      error: undefined,
      segments: job.segments.map((segment) =>
        segment.status === 'generating'
          ? {
              ...segment,
              status: 'cancelled' as const,
              error: undefined,
            }
          : segment,
      ),
    });

    /*
     * Best-effort interruption of whatever ComfyUI is currently doing.
     *
     * The NeoAcademy job has already been persisted as cancelled above,
     * so failure to contact ComfyUI must not undo the cancellation.
     */
    const baseUrl = (
      process.env.VIDEO_COMFYUI_BASE_URL || 'http://127.0.0.1:3100'
    ).replace(/\/$/, '');

    try {
      await fetch(`${baseUrl}/interrupt`, {
        method: 'POST',
      });
    } catch (error) {
      console.warn('Could not interrupt ComfyUI during video cancellation:', error);
    }

    return NextResponse.json({
      success: true,
      status: cancelledJob.status,
    });
  } catch (error) {
    console.error('Failed to cancel long video job:', error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to cancel long video job',
      },
      {
        status: 500,
      },
    );
  }
}