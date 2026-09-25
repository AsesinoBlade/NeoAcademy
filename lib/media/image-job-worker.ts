import fs from 'node:fs/promises';

import {
  loadImageJob,
  saveImageJob,
  getImageJobOutputPath,
} from './image-job-store';

import {
  generateWithComfyUi,
} from './adapters/comfyui-adapter';

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
} from './types';

import {
  enhanceFluxImagePrompt,
} from './image-prompt-enhancer';

function pathToDataUrl(
  bytes: Buffer,
  extension: string,
): string {
  const mimeType =
    extension === 'jpg' ||
    extension === 'jpeg'
      ? 'image/jpeg'
      : extension === 'webp'
        ? 'image/webp'
        : 'image/png';

  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function getExtension(
  filePath: string,
): string {
  const dot =
    filePath.lastIndexOf('.');

  return dot >= 0
    ? filePath
        .slice(dot + 1)
        .toLowerCase()
    : 'png';
}

export async function prepareImageJobPrompts(
  jobId: string,
) {
  const job =
    await loadImageJob(jobId);

  if (!job) {
    throw new Error(
      `Image job not found: ${jobId}`,
    );
  }

  if (job.status === 'cancelled') {
    return job;
  }

  try {
    const enhancedPrompt =
      job.enhancePrompt
        ? await enhanceFluxImagePrompt(
            job.prompt,
            {
              hasReferenceImage:
                Boolean(
                  job.sourceImage1Path,
                ),
            },
          )
        : undefined;

    const enhancedSecondPrompt =
      job.secondPrompt &&
      job.enhanceSecondPrompt
        ? await enhanceFluxImagePrompt(
            job.secondPrompt,
            {
              hasReferenceImage:
                Boolean(
                  job.sourceImage2Path,
                ),
              isSecondCompositionPrompt:
                true,
            },
          )
        : undefined;

    return saveImageJob({
      ...job,
      enhancedPrompt,
      enhancedSecondPrompt,
      error: undefined,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    await saveImageJob({
      ...job,
      status: 'failed',
      error: message,
    });

    throw error;
  }
}

export async function runImageJob(
  jobId: string,
  config: ImageGenerationConfig,
) {
  const job =
    await loadImageJob(jobId);

  if (!job) {
    throw new Error(
      `Image job not found: ${jobId}`,
    );
  }

  if (job.status === 'cancelled') {
    return job;
  }

  const generatingJob =
    await saveImageJob({
      ...job,
      status: 'generating',
      error: undefined,
    });

  try {
    const options:
      ImageGenerationOptions = {
        prompt:
          generatingJob.enhancePrompt &&
          generatingJob.enhancedPrompt
            ? generatingJob.enhancedPrompt
            : generatingJob.prompt,

        secondPrompt:
          generatingJob.enhanceSecondPrompt &&
          generatingJob.enhancedSecondPrompt
            ? generatingJob.enhancedSecondPrompt
            : generatingJob.secondPrompt,

        negativePrompt:
          generatingJob.negativePrompt,

        width:
          generatingJob.width,

        height:
          generatingJob.height,
      };

    if (
      generatingJob.sourceImage1Path
    ) {
      const bytes =
        await fs.readFile(
          generatingJob.sourceImage1Path,
        );

      options.inputImageBase64 =
        pathToDataUrl(
          bytes,
          getExtension(
            generatingJob.sourceImage1Path,
          ),
        );
    }

    if (
      generatingJob.sourceImage2Path
    ) {
      const bytes =
        await fs.readFile(
          generatingJob.sourceImage2Path,
        );

      options.secondImageBase64 =
        pathToDataUrl(
          bytes,
          getExtension(
            generatingJob.sourceImage2Path,
          ),
        );
    }

    const result =
      await generateWithComfyUi(
        config,
        options,
      );

    if (!result.base64) {
      throw new Error(
        'ComfyUI image generation returned no image data.',
      );
    }

    const outputPath =
      getImageJobOutputPath(jobId);

    await fs.writeFile(
      outputPath,
      Buffer.from(
        result.base64,
        'base64',
      ),
    );

    const latestJob =
      await loadImageJob(jobId);

    if (
      latestJob?.status === 'cancelled'
    ) {
      return latestJob;
    }

    return saveImageJob({
      ...generatingJob,
      status: 'completed',
      outputPath,
      error: undefined,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    const latestJob =
      await loadImageJob(jobId);

    if (
      latestJob?.status === 'cancelled'
    ) {
      return latestJob;
    }

    await saveImageJob({
      ...generatingJob,
      status: 'failed',
      error: message,
    });

    throw error;
  }
}