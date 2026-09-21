import { NextRequest } from 'next/server';

import { deleteLongVideoJobsForStage } from '@/lib/media/long-video-job-store';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';

const log = createLogger('Long Video Cleanup API');

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      stageId?: string;
    };

    const stageId = body.stageId?.trim();

    if (!stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }

    const result = await deleteLongVideoJobsForStage(stageId);

    log.info(
      `Cleaned long-video jobs for stage ${stageId}: deleted=${result.deleted}, skippedActive=${result.skippedActive}`,
    );

    return apiSuccess(result);
  } catch (error) {
    log.error('Failed to clean long-video jobs:', error);

    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
