import { type NextRequest } from 'next/server';
import {
  apiError,
  apiSuccess,
  API_ERROR_CODES,
} from '@/lib/server/api-response';
import { getRecentServerErrorLogs } from '@/lib/logger';
import {
  isValidClassroomId,
  readClassroomFailureLog,
  writeClassroomFailureLog,
  type ClassroomFailureDiagnostics,
} from '@/lib/server/classroom-storage';

export async function POST(request: NextRequest) {
  try {
    const body =
      (await request.json()) as ClassroomFailureDiagnostics;

    if (
      !body?.classroomId ||
      !body?.error?.message
    ) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required failure diagnostics',
      );
    }

    if (!isValidClassroomId(body.classroomId)) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        'Invalid classroom id',
      );
    }

    const serverDiagnostics =
      getRecentServerErrorLogs({
        withinMs: 15 * 60 * 1000,
        limit: 160,
      });

    await writeClassroomFailureLog({
      ...body,
      serverDiagnostics,
    });

    return apiSuccess({
      saved: true,
      classroomId: body.classroomId,
    });
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to save classroom failure log',
      error instanceof Error
        ? error.message
        : String(error),
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const id =
      request.nextUrl.searchParams.get('id');

    if (!id) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        'Invalid classroom id',
      );
    }

    const log =
      await readClassroomFailureLog(id);

    if (log === null) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        404,
        'Failure log not found',
      );
    }

    return new Response(log, {
      status: 200,
      headers: {
        'Content-Type':
          'text/plain; charset=utf-8',
        'Content-Disposition':
          `attachment; filename="classroom-${id}-failure.log"`,
        'Cache-Control':
          'no-store',
      },
    });
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to retrieve classroom failure log',
      error instanceof Error
        ? error.message
        : String(error),
    );
  }
}