import { NextRequest, NextResponse } from 'next/server';

import {
  getLocalComfyUiStatus,
  startLocalComfyUi,
  stopLocalComfyUi,
} from '@/lib/server/local-comfyui';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({
      success: true,
      ...(await getLocalComfyUiStatus()),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      action?: 'start' | 'stop';
    };

    if (body.action === 'start') {
      // GPU exclusivity: ComfyUI must never start while an LLM is resident —
      // there is not enough GPU memory for both. This guard covers every
      // caller (class media phase, ebook pictures, anything added later).
      const { ensureNoResidentOllamaModels } = await import('@/lib/server/local-llm');
      const gpu = await ensureNoResidentOllamaModels();
      if (!gpu.clear) {
        return NextResponse.json(
          {
            success: false,
            error:
              `${gpu.message ?? 'An Ollama model is still loaded.'} ComfyUI was not started, to avoid running out of GPU memory. ` +
              'Close other apps using Ollama (chat front-ends, IDE plugins), or run "ollama stop <model>", then resume.',
            remainingModels: gpu.remaining,
          },
          { status: 409 },
        );
      }
      return NextResponse.json(await startLocalComfyUi());
    }

    if (body.action === 'stop') {
      return NextResponse.json(await stopLocalComfyUi());
    }

    return NextResponse.json(
      {
        success: false,
        error: 'action must be "start" or "stop"',
      },
      { status: 400 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
