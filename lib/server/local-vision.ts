import { createLogger } from '@/lib/logger';
import type { VisualRegion } from '@/lib/types/generation';
import {
  unloadAllLocalOllamaModels,
  unloadLocalOllamaModel,
} from '@/lib/server/local-llm';

const log = createLogger('Local Vision');

const DEFAULT_VISION_MODEL =
  'qwen3-vl:8b';

const OLLAMA_NATIVE_BASE_URL =
  'http://127.0.0.1:11434';

export interface LocalVisionInput {
  key: string;
  sourceFileName: string;
  imageId: string;
  src: string;
  pageNumber?: number;
}

export interface LocalVisualAnalysis {
  observations: string[];
  interpretations: string[];
  uncertaintyNotes: string[];
  visualRegions: VisualRegion[];
  classroomSummary: string;
  model: string;
}

interface OllamaGenerateResponse {
  response?: string;
}

function getVisionModel(): string {
  return (
    process.env.LOCAL_VISION_MODEL?.trim() ||
    DEFAULT_VISION_MODEL
  );
}

function dataUrlToBase64(
  src: string,
): string {
  const commaIndex =
    src.indexOf(',');

  if (
    src.startsWith('data:') &&
    commaIndex >= 0
  ) {
    return src.slice(commaIndex + 1);
  }

  return src;
}

function normalizeStringArray(
  value: unknown,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is string =>
        typeof item === 'string',
    )
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeVisualRegions(
  value: unknown,
): VisualRegion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const regions: VisualRegion[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const record =
      item as Record<string, unknown>;

    const label =
      typeof record.label === 'string'
        ? record.label.trim()
        : '';

    const description =
      typeof record.description === 'string'
        ? record.description.trim()
        : undefined;

    const x = Number(record.x);
    const y = Number(record.y);
    const width = Number(record.width);
    const height = Number(record.height);

    if (
      !label ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      continue;
    }

    const clampedX =
      Math.min(1, Math.max(0, x));

    const clampedY =
      Math.min(1, Math.max(0, y));

    const clampedWidth =
      Math.min(
        1 - clampedX,
        Math.max(0, width),
      );

    const clampedHeight =
      Math.min(
        1 - clampedY,
        Math.max(0, height),
      );

    if (
      clampedWidth <= 0 ||
      clampedHeight <= 0
    ) {
      continue;
    }

    const confidenceValue =
      Number(record.confidence);

    regions.push({
      label,
      description,
      x: clampedX,
      y: clampedY,
      width: clampedWidth,
      height: clampedHeight,
      confidence:
        Number.isFinite(confidenceValue)
          ? Math.min(
              1,
              Math.max(
                0,
                confidenceValue,
              ),
            )
          : undefined,
    });
  }

  return regions;
}

function parseVisualAnalysis(
  raw: string,
  model: string,
): LocalVisualAnalysis {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'Vision model returned invalid JSON',
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object'
  ) {
    throw new Error(
      'Vision model returned an invalid analysis object',
    );
  }

  const record =
    parsed as Record<string, unknown>;

  const observations =
    normalizeStringArray(
      record.observations,
    );

  const interpretations =
    normalizeStringArray(
      record.interpretations,
    );

  const uncertaintyNotes =
    normalizeStringArray(
      record.uncertaintyNotes,
    );

  const visualRegions =
    normalizeVisualRegions(
      record.visualRegions,
    );

  const classroomSummary =
    typeof record.classroomSummary ===
    'string'
      ? record.classroomSummary.trim()
      : '';

  if (
    observations.length === 0 &&
    interpretations.length === 0 &&
    !classroomSummary
  ) {
    throw new Error(
      'Vision model returned an empty analysis',
    );
  }

  return {
    observations,
    interpretations,
    uncertaintyNotes,
    visualRegions,
    classroomSummary,
    model,
  };
}

function createVisionPrompt(
  input: LocalVisionInput,
): string {
  const location =
    input.pageNumber
      ? `page ${input.pageNumber}`
      : 'standalone source image';

  return `
You are analyzing an image that will be used as source material for an educational class.

Source file: ${input.sourceFileName}
Source location: ${location}

Return ONLY valid JSON using exactly this shape:

{
  "observations": [
    "directly visible fact"
  ],
  "interpretations": [
    "careful inference from the visible evidence"
  ],
  "uncertaintyNotes": [
    "anything that cannot be determined confidently"
  ],
  "visualRegions": [
    {
      "label": "short human-readable feature name",
      "description": "literal visible feature contained in this region",
      "x": 0.0,
      "y": 0.0,
      "width": 0.0,
      "height": 0.0,
      "confidence": 0.0
    }
  ],
  "classroomSummary": "a concise educational description of what the image contributes to the source material"
}

Rules:

1. OBSERVATIONS must contain only literal, directly visible properties. An observation must be describable without relying on specialized domain knowledge, diagnosis, classification, or an explanation of what the visible feature means.

2. Use neutral physical descriptions in OBSERVATIONS. Describe color, shape, position, visible texture, markings, readable text, relative size, orientation, and visible geometry literally.

3. A technical or learned category is NOT automatically a direct observation, even when it seems visually obvious. Put such labels in INTERPRETATIONS unless the label is literally written in the image.

Examples:
- Observation: "The animal has a brown coat."
- Interpretation: "The coat may be consistent with chestnut coloration."
- Do NOT write "chestnut coat" as a direct observation.

- Observation: "One front leg is extended forward."
- Interpretation: "The limb position may be consistent with a walking gait."
- Do NOT write "walking", "walking motion", or "walking gait" as a direct observation.

- Observation: "The mane and tail appear darker than the body."
- Interpretation: "The color pattern may be relevant to a technical coat-color classification."
- Do NOT convert visible color differences directly into a genetic or breed classification.

- Observation: "The neck appears broad" or "visible muscle contours are present", if clearly visible.
- Interpretation: "These features may be associated with some breed or body types."
- Do NOT write "athletic", "draft type", "healthy", "well-conditioned", or similar functional or diagnostic labels as observations.

- Observation: "The background is plain white."
- Interpretation, only if evidence supports it: "This may have been photographed in a controlled setting."
- Do NOT state "studio", "controlled setting", location, purpose, ownership, or historical context as a fact unless directly visible.

4. Do not turn an inference, classification, identification, diagnosis, cause, purpose, behavior, action category, or interpretation into an observation.

5. INTERPRETATIONS are hypotheses, not source facts. Every interpretation must retain explicit uncertainty language such as "may", "might", "appears consistent with", "possibly", or "likely".

6. Every interpretation should state the literal visible evidence that motivated it when practical.

7. Never allow an interpretation to contradict, replace, or erase a direct observation. If an interpretation conflicts with visible evidence, preserve the visible evidence and put the conflict or ambiguity in uncertaintyNotes.

8. If exact identity, breed, species, model, person, date, location, cause, meaning, diagnosis, gait, behavior, historical context, genetic category, health status, or other technical classification cannot be established visually, say so in uncertaintyNotes.

9. Prefer "cannot be determined from the image alone" over guessing when distinguishing evidence is absent or ambiguous.

10. Transcribe important visible labels, numbers, legends, axes, formulas, captions, or text when readable.

11. For charts and diagrams, describe visible relationships, axes, labels, trends, components, arrows, or structure before inferring what they mean.

12. For photographs, describe physical characteristics, relationships, geometry, orientation, and setting literally before inferring identity, category, behavior, gait, condition, or purpose.

13. Do not invent context that is not visible.

14. Do not describe the source as merely "an image" or "a figure"; explain its useful visual content.

15. classroomSummary must be evidence-conservative. Construct it primarily from OBSERVATIONS using the same literal wording and level of specificity.

16. A claim from INTERPRETATIONS may appear in classroomSummary only if the SAME uncertainty is preserved. If an interpretation says "may indicate a walking gait", the summary must also say "may indicate a walking gait". It must NOT say "is walking", "walking gait", or "depicted walking" as an established fact.

17. Before returning the JSON, silently compare every sentence in classroomSummary against observations and interpretations:
   - If it comes from an observation, do not make it more specific.
   - If it comes from an interpretation, preserve its qualifier.
   - If it appears nowhere in either section, remove it.
   - If uncertaintyNotes say something cannot be determined, the summary must not determine it.

18. If observations and an interpretation appear inconsistent, classroomSummary must preserve that ambiguity rather than choosing one.

19. The result will be used by another language model as source evidence. Direct observations have higher evidentiary status than interpretations, so be deliberately conservative about what is placed in observations.

20. VISUAL REGIONS are spatial localization metadata, not interpretations. Add regions for clearly visible, educationally useful objects or features that another system could point to, highlight, annotate, or make clickable.

21. All visual-region coordinates MUST be normalized to the ORIGINAL FULL IMAGE:
    - x = left edge / image width
    - y = top edge / image height
    - width = region width / image width
    - height = region height / image height
    - every value must be between 0.0 and 1.0
    - x + width must not exceed 1.0
    - y + height must not exceed 1.0

22. Use tight but practical bounding boxes around the visible feature. Do not place a box where the feature is merely expected to be anatomically or conceptually.

23. visualRegions labels must describe literal visible regions such as "body / coat", "mane", "tail", "front hooves", "rear hooves", "head", "legend", "x-axis", or "button". Do not use a technical interpretation such as breed, diagnosis, gait, intent, cause, or health status as a region label unless that exact text is visibly written in the image.

24. If a requested or potentially useful feature cannot be localized confidently, omit the region rather than guessing. confidence is your localization confidence from 0.0 to 1.0.

25. Prefer a small useful set of distinct regions rather than dozens of overlapping boxes. Usually 3-12 regions is enough for an ordinary image.
`.trim();
}

async function analyzeOneImage(
  input: LocalVisionInput,
  model: string,
  signal?: AbortSignal,
): Promise<LocalVisualAnalysis> {
  const response =
    await fetch(
      `${OLLAMA_NATIVE_BASE_URL}/api/generate`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
        },
        signal,
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          prompt:
            createVisionPrompt(input),
          images: [
            dataUrlToBase64(
              input.src,
            ),
          ],
        }),
      },
    );

  if (!response.ok) {
    throw new Error(
      `Local vision request failed (${response.status}): ` +
        `${await response.text()}`,
    );
  }

  const payload =
    (await response.json()) as
      OllamaGenerateResponse;

  const raw =
    payload.response?.trim() || '';

  if (!raw) {
    throw new Error(
      'Local vision model returned an empty response',
    );
  }

  return parseVisualAnalysis(
    raw,
    model,
  );
}

/**
 * Analyze a set of images sequentially with one resident vision model.
 *
 * The teaching LLM is unloaded before the first visual request. The
 * vision model remains resident across the batch and is explicitly
 * unloaded in finally.
 */
export async function analyzeImagesWithLocalVision(
  inputs: LocalVisionInput[],
  signal?: AbortSignal,
): Promise<Map<string, LocalVisualAnalysis>> {
  const results =
    new Map<
      string,
      LocalVisualAnalysis
    >();

  if (inputs.length === 0) {
    return results;
  }

  const model =
    getVisionModel();

  log.info(
    `[Vision] Preparing ${inputs.length} image(s) with ${model}`,
  );

  const unloadResult =
    await unloadAllLocalOllamaModels();

  if (!unloadResult.success) {
    throw new Error(
      'Failed to clear resident Ollama models before vision analysis: ' +
        (unloadResult.message ??
          'unknown error'),
    );
  }

  try {
    for (
      let index = 0;
      index < inputs.length;
      index++
    ) {
      const input =
        inputs[index];

      log.info(
        `[Vision] Analyzing image ${index + 1}/${inputs.length}: ` +
          `${input.sourceFileName}` +
          (input.pageNumber
            ? ` page ${input.pageNumber}`
            : ''),
      );

      const analysis =
        await analyzeOneImage(
          input,
          model,
          signal,
        );

      results.set(
        input.key,
        analysis,
      );
    }

    return results;
  } finally {
    log.info(
      `[Vision] Unloading ${model}`,
    );

    const unload =
      await unloadLocalOllamaModel(
        model,
      );

    if (!unload.success) {
      log.warn(
        `[Vision] Failed to unload ${model}: ` +
          (unload.message ??
            'unknown error'),
      );
    }
  }
}

export function formatVisualAnalysisForSource(
  analysis: LocalVisualAnalysis,
): string {
  const lines: string[] = [
    'SOURCE USE RULES:',
    '- DIRECT VISUAL OBSERVATIONS are the strongest visual evidence.',
    '- Treat observations literally; do not make them more specific than written.',
    '- A technical classification, gait, breed/type label, diagnosis, behavior, cause, purpose, genetic category, or health judgment is not a direct fact unless the source explicitly establishes it.',
    '- VISION MODEL INTERPRETATIONS are hypotheses only, not established source facts.',
    '- Preserve every uncertainty word from an interpretation, including may, might, possibly, likely, appears, consistent with, and cannot be determined.',
    '- Do not strengthen, remove, or silently drop uncertainty from an interpretation.',
    '- Do not use an interpretation to contradict or override a direct visual observation.',
    '- If observations and interpretations conflict, preserve the conflict and explain the uncertainty rather than choosing a side without additional evidence.',
    '- Do not derive a more specific identity, category, cause, diagnosis, history, gait, behavior, genetic conclusion, or technical conclusion than the evidence supports.',
    '- VISION SUMMARY is secondary to the detailed sections. If the summary is more specific or more certain than OBSERVATIONS or INTERPRETATIONS, use the more conservative detailed evidence instead.',
    '',
  ];

  if (
    analysis.observations.length > 0
  ) {
    lines.push(
      'DIRECT VISUAL OBSERVATIONS:',
    );

    for (
      const observation of
      analysis.observations
    ) {
      lines.push(
        `- ${observation}`,
      );
    }
  }

  if (
    analysis.interpretations.length >
    0
  ) {
    if (lines.length > 0) {
      lines.push('');
    }

    lines.push(
      'VISION MODEL INTERPRETATIONS:',
    );

    for (
      const interpretation of
      analysis.interpretations
    ) {
      lines.push(
        `- ${interpretation}`,
      );
    }
  }

  if (
    analysis.uncertaintyNotes.length >
    0
  ) {
    if (lines.length > 0) {
      lines.push('');
    }

    lines.push(
      'UNCERTAINTY / LIMITATIONS:',
    );

    for (
      const note of
      analysis.uncertaintyNotes
    ) {
      lines.push(
        `- ${note}`,
      );
    }
  }

  if (analysis.classroomSummary) {
    if (lines.length > 0) {
      lines.push('');
    }

    lines.push(
      'VISION SUMMARY (PRESERVE ALL QUALIFIERS):',
    );

    lines.push(
      analysis.classroomSummary,
    );
  }

  return lines.join('\n');
}