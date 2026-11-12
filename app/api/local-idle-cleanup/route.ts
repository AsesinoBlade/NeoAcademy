import { NextResponse } from "next/server";

import { unloadAllLocalOllamaModels } from "@/lib/server/local-llm";
import { stopLocalComfyUi } from "@/lib/server/local-comfyui";
import { stopLocalSpeechServicesIfIdle } from "@/lib/server/local-speech-services";
import { listActiveImageJobIds } from "@/lib/media/image-job-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CleanupResult {
  service: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export async function POST() {
  // Anything that requests speech after this moment (e.g. a classroom opened
  // while this slow cleanup is still running) wins over the cleanup.
  const cleanupStartedAt = Date.now();
  const results: CleanupResult[] = [];

  // Never pull the LLM or ComfyUI out from under a running image job.
  const activeImageJobs = await listActiveImageJobIds();
  if (activeImageJobs.length > 0) {
    results.push({
      service: "comfyui",
      success: true,
      result: {
        skipped: true,
        reason: `image job(s) running: ${activeImageJobs.join(", ")}`,
      },
    } as CleanupResult);
  }

  if (activeImageJobs.length === 0)
    try {
      const result = await unloadAllLocalOllamaModels();

      results.push({
        service: "ollama",
        success: result.success,
        result,
      });
    } catch (error) {
      results.push({
        service: "ollama",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }

  if (activeImageJobs.length === 0)
    try {
      const result = await stopLocalComfyUi();

      results.push({
        service: "comfyui",
        success: result.success,
        result,
      });
    } catch (error) {
      results.push({
        service: "comfyui",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }

  /*
   * Stop speech last because this may also shut down Docker Desktop
   * when Docker was originally started and is owned by NeoAcademy.
   */
  try {
    const result = await stopLocalSpeechServicesIfIdle(cleanupStartedAt);

    results.push({
      service: "speech",
      success: result.success,
      result,
    });
  } catch (error) {
    results.push({
      service: "speech",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return NextResponse.json({
    success: results.every((entry) => entry.success),
    results,
  });
}
