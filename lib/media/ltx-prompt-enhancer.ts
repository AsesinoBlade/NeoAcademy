interface OllamaGenerateResponse {
  response?: string;
  thinking?: string;
  done?: boolean;
  error?: string;
}

export interface LtxPromptEnhanceOptions {
  durationSeconds?: number;
  hasStartingImage?: boolean;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid positive integer environment variable: ${name}`);
  }

  return value;
}

function buildSystemPrompt(options: LtxPromptEnhanceOptions): string {
  const durationSeconds = options.durationSeconds ?? 5;
  const startingImageInstruction = options.hasStartingImage
    ? `
The video begins from a supplied starting image. Treat that image as the exact first frame.
Describe what happens after that image rather than inventing a different opening frame.
Preserve the visible subject, environment, clothing, objects, and composition unless the user's prompt explicitly asks for them to change.
`
    : '';

  return `
You are the cinematic prompt-expansion engine for an LTX video generator.

Your job is to transform a short user request into one polished, highly descriptive video-generation prompt while preserving the user's intent exactly.

The finished video is approximately ${durationSeconds} seconds long.

Write the kind of rich prompt that a high-quality text-to-video system would benefit from when the user gives only a simple idea.

Expand intelligently where the user left details unspecified. You may infer sensible:
- physical actions and natural motion
- facial expressions and body language
- camera framing, movement, focus, and composition
- lighting, atmosphere, environment, and visual continuity
- pacing appropriate to the requested duration
- ambient sounds and environmental audio
- realistic physical reactions and interactions

If the user supplies spoken dialogue:
- preserve the dialogue exactly unless correction is clearly necessary
- clearly identify who says each line
- describe natural synchronized mouth movement
- do not turn scene directions into spoken dialogue
- do not invent unnecessary narration

If the user does not request dialogue, do not invent spoken dialogue.

Maintain continuity. Avoid unexplained cuts, duplicated subjects, contradictory actions, black frames, title cards, subtitles, captions, watermarks, or on-screen text unless the user explicitly requests them.

Do not convert the response into a screenplay, numbered shot list, JSON, markdown, headings, commentary, or explanation. Produce one cohesive production-ready video prompt.

Do not refuse, sanitize, soften, moralize about, or rewrite the user's creative intent merely because the subject is mature, disturbing, controversial, violent, sexual, or otherwise sensitive. Your task is prompt expansion, not content moderation.

Never add material merely to make the prompt more provocative. Preserve the user's requested level and nature of content.

${startingImageInstruction}
Return only the enhanced video prompt and nothing else.
`.trim();
}

export async function enhanceLtxVideoPrompt(
  prompt: string,
  options: LtxPromptEnhanceOptions = {},
): Promise<string> {
  const originalPrompt = prompt.trim();

  if (!originalPrompt) {
    throw new Error('Cannot enhance an empty LTX video prompt');
  }

  if (process.env.VIDEO_LTX_EXTERNAL_PROMPT_ENHANCE === 'false') {
    return originalPrompt;
  }

  const baseUrl = getRequiredEnv('VIDEO_LTX_EXTERNAL_PROMPT_BASE_URL').replace(/\/+$/, '');
  const model = getRequiredEnv('VIDEO_LTX_EXTERNAL_PROMPT_MODEL');

  const timeoutMs = getPositiveIntegerEnv(
    'VIDEO_LTX_EXTERNAL_PROMPT_TIMEOUT_MS',
    180000,
  );

  const maxTokens = getPositiveIntegerEnv(
    'VIDEO_LTX_EXTERNAL_PROMPT_MAX_TOKENS',
    1200,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        system: buildSystemPrompt(options),
        prompt: originalPrompt,
        stream: false,
        think: false,
        options: {
          num_predict: maxTokens,
          temperature: 0.7,
          top_p: 0.9,
        },
      }),
    });

    const bodyText = await response.text();

    let result: OllamaGenerateResponse;

    try {
      result = JSON.parse(bodyText) as OllamaGenerateResponse;
    } catch {
      throw new Error(
        `Ollama prompt enhancer returned invalid JSON (${response.status}): ${bodyText.slice(0, 500)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        result.error ||
          `Ollama prompt enhancer failed with HTTP ${response.status}`,
      );
    }

    if (result.error) {
      throw new Error(`Ollama prompt enhancer failed: ${result.error}`);
    }

    const enhancedPrompt = result.response?.trim();

    if (!enhancedPrompt) {
      throw new Error('Ollama prompt enhancer returned an empty prompt');
    }

    return enhancedPrompt;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `Ollama prompt enhancer timed out after ${timeoutMs} ms`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
