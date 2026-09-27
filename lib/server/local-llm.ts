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
/**
 * Unload one specific model from the local Ollama server.
 *
 * This uses Ollama's native API rather than the OpenAI-compatible endpoint.
 */
export async function unloadLocalOllamaModel(
  model: string,
): Promise<UnloadLocalLlmResult> {
  const trimmedModel = model.trim();

  if (!trimmedModel) {
    return {
      success: true,
      skipped: true,
    };
  }

  try {
    const response = await fetch(
      'http://127.0.0.1:11434/api/generate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: trimmedModel,
          prompt: '',
          keep_alive: 0,
        }),
      },
    );

    if (!response.ok) {
      return {
        success: false,
        model: trimmedModel,
        message: await response.text(),
      };
    }

    return {
      success: true,
      model: trimmedModel,
    };
  } catch (error) {
    return {
      success: false,
      model: trimmedModel,
      message:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

/**
 * Unload every model currently resident in local Ollama.
 *
 * This is used before starting GPU-heavy non-Ollama workloads such
 * as MinerU so the two systems never intentionally share VRAM.
 */
export async function unloadAllLocalOllamaModels(): Promise<UnloadLocalLlmResult> {
  const baseUrl =
    process.env.OPENAI_BASE_URL || '';

  const isLocalOllama =
    baseUrl.includes('127.0.0.1:11434') ||
    baseUrl.includes('localhost:11434');

  if (!isLocalOllama) {
    return {
      success: true,
      skipped: true,
    };
  }

  try {
    const response = await fetch(
      'http://127.0.0.1:11434/api/ps',
      {
        method: 'GET',
      },
    );

    if (!response.ok) {
      return {
        success: false,
        message:
          `Unable to query running Ollama models: ` +
          `${await response.text()}`,
      };
    }

    const payload = (await response.json()) as {
      models?: Array<{
        name?: string;
        model?: string;
      }>;
    };

    const models = Array.from(
      new Set(
        (payload.models ?? [])
          .map(
            (entry) =>
              entry.name ||
              entry.model ||
              '',
          )
          .filter(Boolean),
      ),
    );

    if (models.length === 0) {
      return {
        success: true,
        skipped: true,
      };
    }

    for (const model of models) {
      const result =
        await unloadLocalOllamaModel(model);

      if (!result.success) {
        return {
          success: false,
          model,
          message:
            result.message ??
            `Failed to unload Ollama model ${model}`,
        };
      }
    }

    return {
      success: true,
      message:
        `Unloaded ${models.length} Ollama model(s): ` +
        models.join(', '),
    };
  } catch (error) {
    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
}