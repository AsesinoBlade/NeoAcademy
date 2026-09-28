import { NextResponse } from 'next/server';

import { unloadAllLocalOllamaModels } from '@/lib/server/local-llm';
import { stopLocalComfyUi } from '@/lib/server/local-comfyui';
import { stopLocalSpeechServices } from '@/lib/server/local-speech-services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CleanupResult {
  service: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export async function POST() {
  const results: CleanupResult[] = [];

  try {
    const result = await unloadAllLocalOllamaModels();

    results.push({
      service: 'ollama',
      success: result.success,
      result,
    });
  } catch (error) {
    results.push({
      service: 'ollama',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const result = await stopLocalComfyUi();

    results.push({
      service: 'comfyui',
      success: result.success,
      result,
    });
  } catch (error) {
    results.push({
      service: 'comfyui',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /*
   * Stop speech last because this may also shut down Docker Desktop
   * when Docker was originally started and is owned by NeoAcademy.
   */
  try {
    const result = await stopLocalSpeechServices();

    results.push({
      service: 'speech',
      success: result.success,
      result,
    });
  } catch (error) {
    results.push({
      service: 'speech',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return NextResponse.json({
    success: results.every((entry) => entry.success),
    results,
  });
}