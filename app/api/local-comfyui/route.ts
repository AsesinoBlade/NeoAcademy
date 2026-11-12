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
      // The ComfyUI address the image generator uses: server-providers.yml, then .env.local.
      const { resolveImageBaseUrl } = await import('@/lib/server/provider-config');
      const comfyUrl =
        resolveImageBaseUrl('comfyui', undefined) ||
        process.env.IMAGE_COMFYUI_BASE_URL ||
        process.env.VIDEO_COMFYUI_BASE_URL ||
        'http://127.0.0.1:3100';
      const comfyHost = (() => {
        try {
          return new URL(comfyUrl).hostname;
        } catch {
          return '127.0.0.1';
        }
      })();
      const remote = !/^(127\.|localhost$|::1$|\[::1\]$|0\.0\.0\.0$)/i.test(comfyHost);

      // GPU exclusivity: ComfyUI must never start while an LLM is resident —
      // there is not enough GPU memory for both. This guard covers every
      // caller (class media phase, ebook pictures, anything added later).
      // A ComfyUI on another PC uses that PC's GPU, so the guard doesn't apply.
      const { ensureNoResidentOllamaModels } = await import('@/lib/server/local-llm');
      const gpu = remote ? { clear: true as const, message: undefined, remaining: [] } : await ensureNoResidentOllamaModels();
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
      // No managed ComfyUI here (non-Windows, or COMFYUI_ROOT not set): use one
      // that is already running at the configured address — started by hand,
      // or on another PC on the network.
      if (remote || process.platform !== 'win32' || !process.env.COMFYUI_ROOT) {
        const url = comfyUrl;
        const healthy = await fetch(new URL('/system_stats', url), { signal: AbortSignal.timeout(5000), cache: 'no-store' })
          .then((r) => r.ok)
          .catch(() => false);
        return healthy
          ? NextResponse.json({ success: true, managed: false, reason: 'already-running', baseUrl: url })
          : NextResponse.json(
              {
                success: false,
                error: `No ComfyUI is reachable at ${url}. Start ComfyUI there (or set IMAGE_COMFYUI_BASE_URL to a PC running it).`,
              },
              { status: 503 },
            );
      }
      return NextResponse.json(await startLocalComfyUi());
    }

    if (body.action === 'stop') {
      // Only ComfyUI instances NeoAcademy started itself are ever stopped.
      if (process.platform !== 'win32' || !process.env.COMFYUI_ROOT) {
        return NextResponse.json({ success: true, stopped: false, reason: 'not-managed' });
      }
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
