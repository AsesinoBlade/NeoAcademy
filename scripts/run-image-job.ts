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

  // Where ComfyUI is: server-providers.yml, then .env.local, then the default.
  // On another PC (or not on Windows) it is used as-is: never started, stopped,
  // or given this machine's GPU.
  const { resolveImageBaseUrl } = await import('../lib/server/provider-config');
  const comfyUrl =
    resolveImageBaseUrl('comfyui', undefined) ||
    process.env.IMAGE_COMFYUI_BASE_URL ||
    'http://127.0.0.1:3100';
  const comfyHost = (() => {
    try {
      return new URL(comfyUrl).hostname;
    } catch {
      return '127.0.0.1';
    }
  })();
  const comfyIsRemote = !/^(127\.|localhost$|::1$|\[::1\]$|0\.0\.0\.0$)/i.test(comfyHost);
  const comfyIsManaged = !comfyIsRemote && process.platform === 'win32' && !!process.env.COMFYUI_ROOT;

  const config: ImageGenerationConfig = {
    providerId: 'comfyui',
    apiKey: '',
    baseUrl: comfyUrl,
  };

  console.log(
    `Starting image job: ${jobId}`,
  );

  // Freeing the GPU is only needed when ComfyUI shares this machine's GPU.
  if (!comfyIsRemote) {
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
  } else {
    console.log(`ComfyUI is on another PC (${comfyHost}); this machine's GPU is not needed.`);
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

  let comfyStartResult: { managed?: boolean; alreadyRunning?: boolean };
  if (comfyIsManaged) {
    comfyStartResult = await startLocalComfyUi({
      logPath: `data/image-jobs/${jobId}/comfyui.log`,
    });
  } else {
    // Not ours to start: it must already be running.
    const healthy = await fetch(new URL('/system_stats', comfyUrl), { signal: AbortSignal.timeout(10000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (!healthy) {
      throw new Error(
        `No ComfyUI is reachable at ${comfyUrl}. Start ComfyUI there (with --listen for another PC), or fix IMAGE_COMFYUI_BASE_URL.`,
      );
    }
    console.log(`Using the ComfyUI already running at ${comfyUrl}`);
    comfyStartResult = { managed: false, alreadyRunning: true };
  }

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
      const finalUnloadResult = comfyIsRemote
        ? { success: true, message: undefined as string | undefined }
        : await unloadLocalLlm();

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

main().catch(async (error) => {
  console.error(
    'Image job failed:',
  );

  // Record the failure on the job, so the page shows it instead of waiting forever.
  const jobId = process.argv[2];
  if (jobId) {
    try {
      const { loadImageJob, updateImageJob } = await import('../lib/media/image-job-store');
      const job = await loadImageJob(jobId);
      if (job && job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') {
        await updateImageJob(jobId, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (recordError) {
      console.error('Could not record the failure on the job:', recordError);
    }
  }

  if (error instanceof Error) {
    console.error(error.message);
    console.error(error.stack);
  } else {
    console.error(error);
  }

  process.exitCode = 1;
});