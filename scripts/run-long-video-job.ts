import { generateLongVideoJob } from '../lib/media/long-video-generator';
import type { VideoGenerationConfig } from '../lib/media/types';
import { startLocalComfyUi, stopLocalComfyUi } from '../lib/server/local-comfyui';
import { unloadLocalLlm } from '../lib/server/local-llm';
import { stopLocalSpeechServices } from '../lib/server/local-speech-services';

async function main() {
  const jobId = process.argv[2];

  if (!jobId) {
    throw new Error('Missing job ID. Usage: pnpm dlx tsx scripts/run-long-video-job.ts <jobId>');
  }

  const config: VideoGenerationConfig = {
    providerId: 'comfyui',
    apiKey: '',
  };

  console.log(`Starting long video job: ${jobId}`);

  console.log('Unloading local LLM before video generation...');

  const unloadResult = await unloadLocalLlm();

  if (!unloadResult.success) {
    throw new Error(`Failed to unload local LLM: ${unloadResult.message || 'unknown error'}`);
  }

  if (unloadResult.skipped) {
    console.log('Local LLM unload skipped');
  } else {
    console.log(`Local LLM unloaded: ${unloadResult.model || 'unknown model'}`);
  }

  console.log('Stopping local speech services before video generation...');

  const speechStopResult = await stopLocalSpeechServices();

  if (!speechStopResult.success) {
    throw new Error('Failed to stop local speech services');
  }

  console.log('Local speech services stopped');

  console.log('Ensuring ComfyUI is running...');

  const comfyStartResult = await startLocalComfyUi();

  const comfyUiStartedByThisJob =
    comfyStartResult.managed === true && comfyStartResult.alreadyRunning === false;

  console.log(
    comfyStartResult.alreadyRunning
      ? 'ComfyUI was already running'
      : 'ComfyUI started for long video generation',
  );

  try {
    const result = await generateLongVideoJob(jobId, config);

    console.log(`Long video job completed: ${jobId}`);
    console.log(`Output: ${result.outputPath ?? '(no output path)'}`);
  } finally {
    if (comfyUiStartedByThisJob) {
      console.log('Stopping ComfyUI started by this long video job...');

      const comfyStopResult = await stopLocalComfyUi();

      if (!comfyStopResult.success) {
        console.warn('ComfyUI could not be stopped cleanly');
      } else {
        console.log('ComfyUI stopped');
      }
    } else {
      console.log('Leaving pre-existing ComfyUI instance running');
    }
  }
}

main().catch((error) => {
  console.error('Long video job failed:');

  if (error instanceof Error) {
    console.error(error.message);
    console.error(error.stack);
  } else {
    console.error(error);
  }

  process.exitCode = 1;
});
