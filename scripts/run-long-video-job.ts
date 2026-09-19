import { generateLongVideoJob } from '../lib/media/long-video-generator';
import type { VideoGenerationConfig } from '../lib/media/types';

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

  const result = await generateLongVideoJob(jobId, config);

  console.log(`Long video job completed: ${jobId}`);
  console.log(`Output: ${result.outputPath ?? '(no output path)'}`);
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
