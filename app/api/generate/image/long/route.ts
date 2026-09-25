import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';

import { NextRequest } from 'next/server';

import type {
  ImageJob,
  ImageJobMode,
} from '@/lib/media/image-job';

import {
  ensureImageJobDirectory,
  getImageJobSourcePath,
  saveImageJob,
} from '@/lib/media/image-job-store';

import {
  startImageJobProcess,
} from '@/lib/media/image-job-process';

import {
  apiError,
  apiSuccess,
} from '@/lib/server/api-response';

const MAX_IMAGE_BYTES =
  20 * 1024 * 1024;

function getImageExtension(
  file: File,
): string | null {
  switch (
    file.type.toLowerCase()
  ) {
    case 'image/png':
      return 'png';

    case 'image/jpeg':
      return 'jpg';

    case 'image/webp':
      return 'webp';

    default:
      return null;
  }
}

export async function POST(
  req: NextRequest,
) {
  try {
    const formData =
      await req.formData();

    const promptValue =
      formData.get('prompt');

    const secondPromptValue =
      formData.get('secondPrompt');

    const negativePromptValue =
      formData.get('negativePrompt');

    const enhancePromptValue =
      formData.get('enhancePrompt');

    const enhanceSecondPromptValue =
      formData.get(
        'enhanceSecondPrompt',
      );

    const image1Value =
      formData.get('image1');

    const image2Value =
      formData.get('image2');

    const widthValue =
      formData.get('width');

    const heightValue =
      formData.get('height');

    const stageIdValue =
      formData.get('stageId');

    const elementIdValue =
      formData.get('elementId');

    const prompt =
      typeof promptValue === 'string'
        ? promptValue.trim()
        : '';

    if (!prompt) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'prompt is required',
      );
    }

    const secondPrompt =
      typeof secondPromptValue === 'string' &&
      secondPromptValue.trim()
        ? secondPromptValue.trim()
        : undefined;

    const negativePrompt =
      typeof negativePromptValue === 'string' &&
      negativePromptValue.trim()
        ? negativePromptValue.trim()
        : undefined;

    /*
     * Enhancement defaults OFF unless the caller explicitly requests it.
     * This is important for classroom-generated educational images.
     */
    const enhancePrompt =
      enhancePromptValue === 'true';

    const enhanceSecondPrompt =
      enhanceSecondPromptValue ===
      'true';

    const image1 =
      image1Value instanceof File &&
      image1Value.size > 0
        ? image1Value
        : undefined;

    const image2 =
      image2Value instanceof File &&
      image2Value.size > 0
        ? image2Value
        : undefined;

    if (image2 && !image1) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'image2 requires image1',
      );
    }

    if (secondPrompt && !image2) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'secondPrompt requires image2',
      );
    }

    if (image2 && !secondPrompt) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'image2 requires secondPrompt',
      );
    }

    const width =
      typeof widthValue === 'string'
        ? Number(widthValue)
        : 1024;

    const height =
      typeof heightValue === 'string'
        ? Number(heightValue)
        : 1024;

    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'width and height must be positive integers',
      );
    }

    const stageId =
      typeof stageIdValue === 'string' &&
      stageIdValue.trim()
        ? stageIdValue.trim()
        : undefined;

    const elementId =
      typeof elementIdValue === 'string' &&
      elementIdValue.trim()
        ? elementIdValue.trim()
        : undefined;

    const mode: ImageJobMode =
      image2
        ? 'two-image-edit'
        : image1
          ? 'single-image-edit'
          : 'text-to-image';

    const now =
      new Date().toISOString();

    const jobId =
      randomUUID();

    await ensureImageJobDirectory(
      jobId,
    );

    let sourceImage1Path:
      string | undefined;

    let sourceImage2Path:
      string | undefined;

    if (image1) {
      if (
        image1.size >
        MAX_IMAGE_BYTES
      ) {
        return apiError(
          'INVALID_REQUEST',
          400,
          'image1 must be 20 MB or smaller',
        );
      }

      const extension =
        getImageExtension(image1);

      if (!extension) {
        return apiError(
          'INVALID_REQUEST',
          400,
          'image1 must be PNG, JPEG, or WebP',
        );
      }

      sourceImage1Path =
        getImageJobSourcePath(
          jobId,
          1,
          extension,
        );

      await fs.writeFile(
        sourceImage1Path,
        Buffer.from(
          await image1.arrayBuffer(),
        ),
      );
    }

    if (image2) {
      if (
        image2.size >
        MAX_IMAGE_BYTES
      ) {
        return apiError(
          'INVALID_REQUEST',
          400,
          'image2 must be 20 MB or smaller',
        );
      }

      const extension =
        getImageExtension(image2);

      if (!extension) {
        return apiError(
          'INVALID_REQUEST',
          400,
          'image2 must be PNG, JPEG, or WebP',
        );
      }

      sourceImage2Path =
        getImageJobSourcePath(
          jobId,
          2,
          extension,
        );

      await fs.writeFile(
        sourceImage2Path,
        Buffer.from(
          await image2.arrayBuffer(),
        ),
      );
    }

    const job: ImageJob = {
      id: jobId,
      status: 'queued',
      mode,
      origin:
        stageId
          ? 'classroom'
          : 'standalone',
      stageId,
      elementId,
      prompt,
      enhancePrompt,
      secondPrompt,
      enhanceSecondPrompt:
        image2
          ? enhanceSecondPrompt
          : false,
      negativePrompt,
      width,
      height,
      sourceImage1Path,
      sourceImage2Path,
      createdAt: now,
      updatedAt: now,
    };

    const savedJob =
      await saveImageJob(job);

    startImageJobProcess(
      savedJob.id,
    );

    return apiSuccess(
      {
        jobId:
          savedJob.id,

        status:
          savedJob.status,

        mode:
          savedJob.mode,
      },
      202,
    );
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error
        ? error.message
        : String(error),
    );
  }
}