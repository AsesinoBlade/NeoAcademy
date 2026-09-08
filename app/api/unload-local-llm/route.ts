import { NextResponse } from 'next/server';

export async function POST() {
  const baseUrl = process.env.OPENAI_BASE_URL || '';
  const defaultModel = process.env.DEFAULT_MODEL || '';

  // Only manage lifecycle for the local Ollama installation.
  const isLocalOllama = baseUrl.includes('127.0.0.1:11434') || baseUrl.includes('localhost:11434');

  if (!isLocalOllama || !defaultModel) {
    return NextResponse.json({ success: true, skipped: true });
  }

  const colonIndex = defaultModel.indexOf(':');
  const model = colonIndex >= 0 ? defaultModel.slice(colonIndex + 1) : defaultModel;

  try {
    const response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt: '',
        keep_alive: 0,
      }),
    });

    if (!response.ok) {
      const message = await response.text();

      return NextResponse.json(
        {
          success: false,
          message,
        },
        { status: response.status },
      );
    }

    return NextResponse.json({
      success: true,
      model,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
