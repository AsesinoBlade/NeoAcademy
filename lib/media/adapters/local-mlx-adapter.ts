/**
 * Local MLX Image Generation Adapter
 *
 * Uses the OpenAI-compatible image generation API exposed by vMLX.
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8001';
const DEFAULT_MODEL = 'z-image-turbo-8bit';

interface VmlxImageResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
}

function resolveSize(options: ImageGenerationOptions): string {
  const width = options.width || 1024;
  const height = options.height || 1024;

  return `${width}x${height}`;
}

export async function testLocalMlxConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const model = config.model || DEFAULT_MODEL;

  try {
    const response = await fetch(`${baseUrl}/v1/models`);

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        message: `Local MLX server returned ${response.status}: ${text}`,
      };
    }

    const data = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };

    const models = data.data || [];
    const modelFound = models.some((item) => item.id === model);

    if (!modelFound) {
      const availableModels = models
        .map((item) => item.id)
        .filter(Boolean)
        .join(', ');

      return {
        success: false,
        message: `Connected to Local MLX, but model "${model}" was not found. Available: ${availableModels || 'none'}`,
      };
    }

    return {
      success: true,
      message: `Connected to Local MLX (${model})`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Local MLX connectivity error: ${error}`,
    };
  }
}

export async function generateWithLocalMlx(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const model = config.model || DEFAULT_MODEL;

  const width = options.width || 1024;
  const height = options.height || 1024;

  const response = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt: options.prompt,
      size: resolveSize(options),
      n: 1,
      response_format: 'b64_json',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Local MLX image generation failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as VmlxImageResponse;
  const image = data.data?.[0];

  if (!image) {
    throw new Error('Local MLX returned no image data');
  }

  if (image.b64_json) {
    return {
      base64: image.b64_json,
      width,
      height,
    };
  }

  if (image.url) {
    return {
      url: image.url,
      width,
      height,
    };
  }

  throw new Error('Local MLX response contained neither b64_json nor url');
}
