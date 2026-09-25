import { NextRequest } from 'next/server';

import { deleteImageJobsForStage } from '@/lib/media/image-job-store';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';

const log = createLogger('Image Cleanup API');

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      stageId?: string;
    };

    const stageId = body.stageId?.trim();

    if (!stageId) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'stageId is required',
      );
    }

    const result =
      await deleteImageJobsForStage(stageId);

    log.info(
      `Cleaned image jobs for stage ${stageId}: deleted=${result.deleted}, skippedActive=${result.skippedActive}`,
    );

    return apiSuccess(result);
  } catch (error) {
    log.error(
      'Failed to clean image jobs:',
      error,
    );

    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error
        ? error.message
        : String(error),
    );
  }
}