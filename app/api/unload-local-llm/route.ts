import { NextResponse } from 'next/server';

import {
  unloadAllLocalOllamaModels,
} from '@/lib/server/local-llm';

export async function POST() {
  const result =
    await unloadAllLocalOllamaModels();

  if (!result.success) {
    return NextResponse.json(
      result,
      {
        status: 500,
      },
    );
  }

  try {
    const response =
      await fetch(
        'http://127.0.0.1:11434/api/ps',
        {
          method: 'GET',
          cache: 'no-store',
        },
      );

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message:
            'Ollama unload completed, but verification failed: ' +
            `${response.status} ${await response.text()}`,
        },
        {
          status: 500,
        },
      );
    }

    const payload =
      (await response.json()) as {
        models?: Array<{
          name?: string;
          model?: string;
          size?: number;
          size_vram?: number;
        }>;
      };

    const remaining =
      payload.models ?? [];

    if (remaining.length > 0) {
      return NextResponse.json(
        {
          success: false,
          message:
            'Ollama still reports resident model(s) after unload',
          remainingModels:
            remaining.map(
              (model) => ({
                name:
                  model.name ??
                  model.model ??
                  'unknown',
                size:
                  model.size,
                sizeVram:
                  model.size_vram,
              }),
            ),
        },
        {
          status: 500,
        },
      );
    }

    return NextResponse.json({
      ...result,
      success: true,
      verifiedEmpty: true,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message:
          'Ollama unload completed, but verification threw an error: ' +
          (error instanceof Error
            ? error.message
            : String(error)),
      },
      {
        status: 500,
      },
    );
  }
}