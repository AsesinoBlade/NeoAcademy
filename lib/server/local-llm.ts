export interface UnloadLocalLlmResult {
  success: boolean;
  skipped?: boolean;
  model?: string;
  message?: string;
}

export async function unloadLocalLlm(): Promise<UnloadLocalLlmResult> {
  const baseUrl = process.env.OPENAI_BASE_URL || '';
  const defaultModel = process.env.DEFAULT_MODEL || '';

  const isLocalOllama = baseUrl.includes('127.0.0.1:11434') || baseUrl.includes('localhost:11434');

  if (!isLocalOllama || !defaultModel) {
    return {
      success: true,
      skipped: true,
    };
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
      return {
        success: false,
        model,
        message: await response.text(),
      };
    }

    return {
      success: true,
      model,
    };
  } catch (error) {
    return {
      success: false,
      model,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
