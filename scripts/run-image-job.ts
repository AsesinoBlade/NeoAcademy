import {
  prepareImageJobPrompts,
  runImageJob,
} from '../lib/media/image-job-worker';

import type {
  ImageGenerationConfig,
} from '../lib/media/types';

import {
  startLocalComfyUi,
  stopLocalComfyUi,
} from '../lib/server/local-comfyui';

import {
  unloadLocalLlm,
} from '../lib/server/local-llm';

import {
  stopLocalSpeechServices,
} from '../lib/server/local-speech-services';

async function main() {
  const jobId = process.argv[2];

  if (!jobId) {
    throw new Error(
      'Missing job ID. Usage: pnpm dlx tsx scripts/run-image-job.ts <jobId>',
    );
  }

  const config: ImageGenerationConfig = {
    providerId: 'comfyui',
    apiKey: '',
  };

  console.log(
    `Starting image job: ${jobId}`,
  );

  console.log(
    'Unloading local LLM before image generation...',
  );

  const unloadResult =
    await unloadLocalLlm();

  if (!unloadResult.success) {
    throw new Error(
      `Failed to unload local LLM: ${
        unloadResult.message ||
        'unknown error'
      }`,
    );
  }

  console.log(
    'Stopping local speech services before image generation...',
  );

  const speechStopResult =
    await stopLocalSpeechServices();

  if (!speechStopResult.success) {
    throw new Error(
      'Failed to stop local speech services',
    );
  }

  console.log(
    'Preparing image prompts...',
  );

  await prepareImageJobPrompts(
    jobId,
  );

  console.log(
    'Image prompts prepared',
  );

  console.log(
    'Ensuring ComfyUI is running...',
  );

  const comfyStartResult =
    await startLocalComfyUi({
      logPath:
        `data/image-jobs/${jobId}/comfyui.log`,
    });

  const comfyUiStartedByThisJob =
    comfyStartResult.managed === true &&
    comfyStartResult.alreadyRunning === false;

  try {
    const result =
      await runImageJob(
        jobId,
        config,
      );

    console.log(
      `Image job finished: ${jobId}`,
    );

    console.log(
      `Status: ${result.status}`,
    );

    console.log(
      `Output: ${
        result.outputPath ||
        '(no output path)'
      }`,
    );
  } finally {
    if (comfyUiStartedByThisJob) {
      console.log(
        'Stopping ComfyUI started by this image job...',
      );

      const stopResult =
        await stopLocalComfyUi();

      if (!stopResult.success) {
        console.warn(
          'ComfyUI could not be stopped cleanly',
        );
      }
    } else {
      console.log(
        'Leaving pre-existing ComfyUI instance running',
      );
    }

    try {
      const finalUnloadResult =
        await unloadLocalLlm();

      if (!finalUnloadResult.success) {
        console.warn(
          `Local LLM could not be unloaded after image generation: ${
            finalUnloadResult.message ||
            'unknown error'
          }`,
        );
      }
    } catch (error) {
      console.warn(
        'Failed to unload local LLM after image generation:',
        error,
      );
    }
  }
}

main().catch((error) => {
  console.error(
    'Image job failed:',
  );

  if (error instanceof Error) {
    console.error(error.message);
    console.error(error.stack);
  } else {
    console.error(error);
  }

  process.exitCode = 1;
});