interface OllamaGenerateResponse {
  response?: string;
  thinking?: string;
  done?: boolean;
  error?: string;
}

export interface FluxImagePromptEnhanceOptions {
  hasReferenceImage?: boolean;
  isSecondCompositionPrompt?: boolean;
}

function getRequiredEnv(
  name: string,
): string {
  const value =
    process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}`,
    );
  }

  return value;
}

function getPositiveIntegerEnv(
  name: string,
  fallback: number,
): number {
  const raw =
    process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value =
    Number.parseInt(raw, 10);

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    throw new Error(
      `Invalid positive integer environment variable: ${name}`,
    );
  }

  return value;
}

function buildSystemPrompt(
  options: FluxImagePromptEnhanceOptions,
): string {
  const referenceInstruction =
    options.hasReferenceImage
      ? `
A reference image is supplied.

Treat the visible subject, identity, important objects, spatial relationships,
and composition in that image as authoritative unless the user's prompt
explicitly asks for them to change.

Do not casually replace, remove, duplicate, or reinterpret important elements
from the supplied image.
`
      : '';

  const compositionInstruction =
    options.isSecondCompositionPrompt
      ? `
This prompt describes how a second source image should be incorporated into
an already edited first image.

Preserve the user's requested relationship between the two images exactly.
Do not invent a different purpose for the second image.
`
      : '';

  return `
You are the prompt-expansion engine for a local Flux image generator.

Transform the user's image request into one polished image-generation prompt.

The highest priority is preserving the user's actual intent.

Enhance only details that improve rendering quality, composition, lighting,
materials, atmosphere, perspective, photographic or artistic coherence.

Do NOT change the factual or educational meaning of the request.

Do NOT add important objects, labels, numbers, people, relationships,
scientific details, historical claims, anatomical details, diagram elements,
or teaching concepts that the user did not request.

If the original prompt is deliberately simple because it is conveying a
specific fact or teaching point, preserve that simplicity. Improve rendering
clarity without embellishing the meaning.

Never turn a simple educational illustration into a cinematic scene if doing
so could distract from or obscure the concept being taught.

Do not invent text, captions, labels, signs, watermarks, typography, or
written words unless explicitly requested.

When appropriate, you may improve:
- framing and composition
- lighting and exposure
- material and surface detail
- depth and perspective
- environmental coherence
- photographic realism
- artistic consistency
- clarity of the main subject

${referenceInstruction}
${compositionInstruction}

Return only the enhanced image prompt.
Do not return JSON, markdown, headings, analysis, or commentary.
`.trim();
}

export async function enhanceFluxImagePrompt(
  prompt: string,
  options: FluxImagePromptEnhanceOptions = {},
): Promise<string> {
  const originalPrompt =
    prompt.trim();

  if (!originalPrompt) {
    throw new Error(
      'Cannot enhance an empty Flux image prompt',
    );
  }

  /*
   * This environment variable is a master kill switch.
   * Per-request flags decide whether this function is called at all.
   */
  if (
    process.env
      .IMAGE_FLUX_EXTERNAL_PROMPT_ENHANCE ===
    'false'
  ) {
    return originalPrompt;
  }

  const baseUrl =
    getRequiredEnv(
      'IMAGE_FLUX_EXTERNAL_PROMPT_BASE_URL',
    ).replace(/\/+$/, '');

  const model =
    getRequiredEnv(
      'IMAGE_FLUX_EXTERNAL_PROMPT_MODEL',
    );

  const timeoutMs =
    getPositiveIntegerEnv(
      'IMAGE_FLUX_EXTERNAL_PROMPT_TIMEOUT_MS',
      180000,
    );

  const maxTokens =
    getPositiveIntegerEnv(
      'IMAGE_FLUX_EXTERNAL_PROMPT_MAX_TOKENS',
      1200,
    );

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      timeoutMs,
    );

  try {
    const response =
      await fetch(
        `${baseUrl}/api/generate`,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            system:
              buildSystemPrompt(
                options,
              ),
            prompt:
              originalPrompt,
            stream: false,
            think: false,

            /*
             * Do not leave the enhancer model occupying VRAM.
             * ComfyUI starts after enhancement is complete.
             */
            keep_alive: 0,

            options: {
              num_predict:
                maxTokens,
              temperature: 0.55,
              top_p: 0.9,
            },
          }),
        },
      );

    const bodyText =
      await response.text();

    let result:
      OllamaGenerateResponse;

    try {
      result =
        JSON.parse(
          bodyText,
        ) as OllamaGenerateResponse;
    } catch {
      throw new Error(
        `Ollama image prompt enhancer returned invalid JSON (${response.status}): ${bodyText.slice(0, 500)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        result.error ||
          `Ollama image prompt enhancer failed with HTTP ${response.status}`,
      );
    }

    if (result.error) {
      throw new Error(
        `Ollama image prompt enhancer failed: ${result.error}`,
      );
    }

    const enhancedPrompt =
      result.response?.trim();

    if (!enhancedPrompt) {
      throw new Error(
        'Ollama image prompt enhancer returned an empty prompt',
      );
    }

    return enhancedPrompt;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'AbortError'
    ) {
      throw new Error(
        `Ollama image prompt enhancer timed out after ${timeoutMs} ms`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}