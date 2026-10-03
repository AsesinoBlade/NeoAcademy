import { type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  buildRequestOrigin,
  deleteClassroom,
  isValidClassroomId,
  listClassrooms,
  persistClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      stage,
      scenes,
      currentSceneId,
      chats,
      outlines,
      status,
      error,
      requirement,
    } = body;

    if (!stage || !Array.isArray(scenes)) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required fields: stage, scenes',
      );
    }

    const id = stage.id || randomUUID();

    if (!isValidClassroomId(id)) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        'Invalid classroom id',
      );
    }

    const baseUrl = buildRequestOrigin(request);

    const persisted = await persistClassroom(
      {
        id,
        stage: {
          ...stage,
          id,
        },
        scenes,
        currentSceneId,
        chats,
        outlines,
        status,
        error,
        requirement,
      },
      baseUrl,
    );

    return apiSuccess(
      {
        id: persisted.id,
        url: persisted.url,
        status: persisted.status,
      },
      201,
    );
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to store classroom',
      error instanceof Error
        ? error.message
        : String(error),
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');

    if (!id) {
      const classrooms = await listClassrooms();

      return apiSuccess({
        classrooms,
      });
    }

    if (!isValidClassroomId(id)) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        'Invalid classroom id',
      );
    }

    const classroom = await readClassroom(id);

    if (!classroom) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        404,
        'Classroom not found',
      );
    }

    return apiSuccess({
      classroom,
    });
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to retrieve classroom',
      error instanceof Error
        ? error.message
        : String(error),
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');

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

    await deleteClassroom(id);

    return apiSuccess({
      deleted: true,
      id,
    });
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to delete classroom',
      error instanceof Error
        ? error.message
        : String(error),
    );
  }
}