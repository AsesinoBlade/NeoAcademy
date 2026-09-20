import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';

import { NextRequest } from 'next/server';

import { getLongVideoJobFinalOutputPath, loadLongVideoJob } from '@/lib/media/long-video-job-store';

interface RouteContext {
  params: Promise<{
    jobId: string;
  }>;
}

function createWebStream(
  filePath: string,
  options?: {
    start?: number;
    end?: number;
  },
): ReadableStream {
  return Readable.toWeb(fs.createReadStream(filePath, options)) as ReadableStream;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { jobId } = await context.params;

    const job = await loadLongVideoJob(jobId);

    if (!job) {
      return new Response('Video job not found', {
        status: 404,
      });
    }

    if (job.status !== 'completed') {
      return new Response('Video is not ready', {
        status: 409,
      });
    }

    const filePath = getLongVideoJobFinalOutputPath(jobId);

    let stats;

    try {
      stats = await fsp.stat(filePath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return new Response('Video output not found', {
          status: 404,
        });
      }

      throw error;
    }

    if (!stats.isFile()) {
      return new Response('Video output not found', {
        status: 404,
      });
    }

    const fileSize = stats.size;
    const range = request.headers.get('range');

    if (!range) {
      return new Response(createWebStream(filePath), {
        status: 200,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes',
          'Content-Disposition': 'inline; filename="video.mp4"',
          'Cache-Control': 'private, no-store',
        },
      });
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());

    if (!match) {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${fileSize}`,
        },
      });
    }

    let start: number;
    let end: number;

    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : fileSize - 1;
    } else if (match[2]) {
      const suffixLength = Number(match[2]);

      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${fileSize}`,
          },
        });
      }

      start = Math.max(fileSize - suffixLength, 0);
      end = fileSize - 1;
    } else {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${fileSize}`,
        },
      });
    }

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      start >= fileSize
    ) {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${fileSize}`,
        },
      });
    }

    end = Math.min(end, fileSize - 1);

    const contentLength = end - start + 1;

    return new Response(
      createWebStream(filePath, {
        start,
        end,
      }),
      {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(contentLength),
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': 'inline; filename="video.mp4"',
          'Cache-Control': 'private, no-store',
        },
      },
    );
  } catch (error) {
    console.error('Failed to serve long video output:', error);

    return new Response('Failed to serve video', {
      status: 500,
    });
  }
}
