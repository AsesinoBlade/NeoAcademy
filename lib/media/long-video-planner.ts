import type { LanguageModel } from 'ai';

import { callLLM } from '@/lib/ai/llm';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import { createLogger } from '@/lib/logger';

import type { LongVideoPlan, LongVideoSegment, VideoSegmentTransition } from './long-video-plan';

const log = createLogger('Long Video Planner');

const SEGMENT_DURATION_SECONDS = 5;

export interface CreateLongVideoPlanOptions {
  prompt: string;
  targetDurationSeconds: number;
}

export interface GenerateLongVideoPlanOptions extends CreateLongVideoPlanOptions {
  model: LanguageModel;
  maxOutputTokens?: number;
}

interface PlannedSegmentResponse {
  index?: number;
  transition?: string;
  prompt?: string;
}

interface LongVideoPlannerResponse {
  segments?: PlannedSegmentResponse[];
}

export function createEmptyLongVideoPlan(options: CreateLongVideoPlanOptions): LongVideoPlan {
  if (!options.prompt.trim()) {
    throw new Error('Long video prompt is required');
  }

  if (!Number.isFinite(options.targetDurationSeconds) || options.targetDurationSeconds <= 0) {
    throw new Error('Target duration must be greater than zero');
  }

  if (options.targetDurationSeconds % SEGMENT_DURATION_SECONDS !== 0) {
    throw new Error(`Target duration must be divisible by ${SEGMENT_DURATION_SECONDS} seconds`);
  }

  const segmentCount = options.targetDurationSeconds / SEGMENT_DURATION_SECONDS;

  const segments: LongVideoSegment[] = Array.from(
    {
      length: segmentCount,
    },
    (_, index) => ({
      index,
      durationSeconds: SEGMENT_DURATION_SECONDS,
      prompt: '',
      transition: (index === 0 ? 'cut' : 'continue') as VideoSegmentTransition,
    }),
  );

  return {
    targetDurationSeconds: options.targetDurationSeconds,
    segmentDurationSeconds: SEGMENT_DURATION_SECONDS,
    segments,
  };
}

export function validateLongVideoPlan(plan: LongVideoPlan): void {
  if (plan.segments.length === 0) {
    throw new Error('Long video plan contains no segments');
  }

  const expectedSegmentCount = plan.targetDurationSeconds / plan.segmentDurationSeconds;

  if (!Number.isInteger(expectedSegmentCount) || expectedSegmentCount !== plan.segments.length) {
    throw new Error('Long video plan segment count does not match target duration');
  }

  for (let index = 0; index < plan.segments.length; index++) {
    const segment = plan.segments[index];

    if (segment.index !== index) {
      throw new Error(`Long video segment ${index} has an invalid index`);
    }

    if (segment.durationSeconds !== plan.segmentDurationSeconds) {
      throw new Error(`Long video segment ${index} has an invalid duration`);
    }

    if (!segment.prompt.trim()) {
      throw new Error(`Long video segment ${index} has no prompt`);
    }

    if (segment.transition !== 'continue' && segment.transition !== 'cut') {
      throw new Error(`Long video segment ${index} has an invalid transition`);
    }
  }

  if (plan.segments[0].transition !== 'cut') {
    throw new Error('The first long video segment must start with a cut');
  }

  const totalDuration = plan.segments.reduce(
    (total, segment) => total + segment.durationSeconds,
    0,
  );

  if (totalDuration !== plan.targetDurationSeconds) {
    throw new Error('Long video plan duration does not match target duration');
  }
}

export async function generateLongVideoPlan(
  options: GenerateLongVideoPlanOptions,
): Promise<LongVideoPlan> {
  const emptyPlan = createEmptyLongVideoPlan(options);
  const segmentCount = emptyPlan.segments.length;

  const systemPrompt = `
You are a video director creating a shot-by-shot plan for an AI video generator.

The finished video is made from consecutive 5-second generated clips.

You must decide what should visually happen during every 5-second segment.

For every segment after the first, choose exactly one transition:

- "continue": Use when the segment should be a natural continuation of the previous shot. The video generator will receive the final frame of the previous clip as its starting image. Preserve subject identity, environment, lighting, framing, scale, and visual style unless the requested action naturally changes them.

- "cut": Use when a deliberate new shot should begin. Use this for a new camera angle, new location, new subject, close-up, wide shot, cutaway, diagram-like view, or any intentional scene change. A cut starts as a fresh text-to-video generation and does not receive the previous final frame.

The first segment must always use "cut".

Plan the entire video as a coherent film, not as unrelated clips.

Use "continue" when continuous motion and visual continuity are desirable.
Use "cut" when changing shots would communicate the user's request better.

Each segment prompt must describe only what should happen during that 5-second segment while containing enough visual information for the video generator to produce the intended shot.

For continuation segments, explicitly describe how the action should continue and what visual characteristics should remain consistent.

For cut segments, fully describe the new shot.

Do not include narration, explanations, timestamps, Markdown, or commentary.

Return valid JSON only in exactly this structure:

{
  "segments": [
    {
      "index": 0,
      "transition": "cut",
      "prompt": "..."
    }
  ]
}

Return exactly the requested number of segments.
Indexes must start at 0 and increase sequentially.
`.trim();

  const userPrompt = `
Create a ${options.targetDurationSeconds}-second video plan.

The video must contain exactly ${segmentCount} segments.
Each segment lasts exactly ${SEGMENT_DURATION_SECONDS} seconds.

User's video request:

${options.prompt.trim()}
`.trim();

  const result = await callLLM(
    {
      model: options.model,
      system: systemPrompt,
      prompt: userPrompt,
      maxOutputTokens: options.maxOutputTokens,
    },
    'long-video-planner',
  );

  const parsed = parseJsonResponse<LongVideoPlannerResponse>(result.text);

  if (!parsed?.segments || !Array.isArray(parsed.segments)) {
    throw new Error('Long video planner returned no valid segment list');
  }

  if (parsed.segments.length !== segmentCount) {
    throw new Error(
      `Long video planner returned ${parsed.segments.length} segments; expected ${segmentCount}`,
    );
  }

  const segments: LongVideoSegment[] = parsed.segments.map((segment, index) => {
    if (segment.index !== index) {
      throw new Error(`Long video planner returned invalid index for segment ${index}`);
    }

    if (segment.transition !== 'continue' && segment.transition !== 'cut') {
      throw new Error(`Long video planner returned invalid transition for segment ${index}`);
    }

    const prompt = segment.prompt?.trim();

    if (!prompt) {
      throw new Error(`Long video planner returned no prompt for segment ${index}`);
    }

    return {
      index,
      durationSeconds: SEGMENT_DURATION_SECONDS,
      transition: segment.transition as VideoSegmentTransition,
      prompt,
    };
  });

  // Segment zero can never be a continuation because there is
  // no previous generated frame available.
  segments[0].transition = 'cut';

  const plan: LongVideoPlan = {
    targetDurationSeconds: options.targetDurationSeconds,
    segmentDurationSeconds: SEGMENT_DURATION_SECONDS,
    segments,
  };

  validateLongVideoPlan(plan);

  log.info(
    `Generated ${plan.segments.length}-segment video plan for ${plan.targetDurationSeconds} seconds`,
  );

  return plan;
}
