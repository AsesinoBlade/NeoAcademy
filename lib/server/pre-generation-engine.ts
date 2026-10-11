/**
 * Pre-Generation Engine
 *
 * Generates a complete course package in one shot:
 * 1. Retrieve context from RAG knowledge base
 * 2. Fetch web search results for enrichment
 * 3. Generate scene outlines (Gemini Flash via key pool)
 * 4. Generate all scene content in parallel (controlled concurrency)
 * 5. Pre-render TTS audio for each scene's speaker notes
 * 6. Save everything to disk as a self-contained course package
 * 7. Register course in SQLite DB
 *
 * The resulting package is served instantly at runtime — zero LLM calls during playback.
 */

import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { smartRouter } from '@/lib/ai/smart-router';
import { retrieveContext, formatContextForPrompt } from '@/lib/rag/retriever';
import { webSearch, formatSearchResultsForPrompt } from '@/lib/web-search/search';
import { generateText } from 'ai';
import { loadSnippet } from '@/lib/generation/prompts';
import { parseJsonResponse } from '@/lib/generation/json-repair';

const log = createLogger('PreGenEngine');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreGenerationInput {
  userId: string;
  topic: string;
  level?: string; // 'GCSE' | 'A-Level' | 'University' | 'General'
  language?: string;
  numScenes?: number;
  useKnowledgeBase?: boolean;
  useWebSearch?: boolean;
  highQuality?: boolean; // Use better model (slower, higher cost)
}

export type PreGenerationStep =
  | 'initializing'
  | 'retrieving_context'
  | 'web_search'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'rendering_audio'
  | 'saving'
  | 'complete'
  | 'error';

export interface PreGenerationProgress {
  step: PreGenerationStep;
  progress: number; // 0–100
  message: string;
  scenesComplete?: number;
  totalScenes?: number;
  courseId?: string;
  error?: string;
}

export type ProgressCallback = (progress: PreGenerationProgress) => void;

interface SceneOutline {
  id: string;
  title: string;
  type: 'slides' | 'quiz' | 'interactive';
  keyPoints: string[];
  /** Detailed teaching brief: exact rules, worked examples, code, pitfalls, exercise + solution */
  teachingNotes?: string;
  speakerNotes: string;
}

const OUTLINE_MAX_OUTPUT_TOKENS = Number.parseInt(
  process.env.COURSE_OUTLINE_MAX_OUTPUT_TOKENS || '16384',
  10,
);
const SCENE_MAX_OUTPUT_TOKENS = Number.parseInt(
  process.env.SCENE_CONTENT_MAX_OUTPUT_TOKENS || '16384',
  10,
);
const TTS_TIMEOUT_MS = Number.parseInt(process.env.COURSE_TTS_TIMEOUT_MS || '300000', 10);

interface GeneratedScene {
  id: string;
  title: string;
  type: string;
  content: Record<string, unknown>;
  speakerNotes: string;
  audioPath?: string;
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function preGenerateCourse(
  input: PreGenerationInput,
  onProgress?: ProgressCallback,
): Promise<{ courseId: string; packagePath: string; sceneCount: number }> {
  const courseId = nanoid();
  const packageDir = path.join(process.cwd(), 'data', 'courses', courseId);
  fs.mkdirSync(packageDir, { recursive: true });

  const progress = (
    step: PreGenerationStep,
    pct: number,
    msg: string,
    extra: Partial<PreGenerationProgress> = {},
  ) => {
    onProgress?.({ step, progress: pct, message: msg, ...extra });
    log.info(`[${step}] ${pct}% — ${msg}`);
  };

  try {
    progress('initializing', 0, `Preparing to generate: "${input.topic}"`);

    // 1. Create course record (status=generating)
    await registerCourse({
      id: courseId,
      userId: input.userId,
      topic: input.topic,
      level: input.level,
      packagePath: `data/courses/${courseId}`,
      status: 'generating',
    });

    // 2. RAG context retrieval (tag-aware)
    progress('retrieving_context', 5, 'Searching knowledge base…');
    let ragContext = '';
    if (input.useKnowledgeBase !== false) {
      const matchedTags = await matchTopicToTags(input.topic);
      if (matchedTags.length > 0) {
        log.info(`Auto-matched tags from topic: ${matchedTags.join(', ')}`);
      }
      const chunks = await retrieveContext(input.topic, {
        userId: input.userId,
        topK: 8,
        tags: matchedTags.length > 0 ? matchedTags : undefined,
        includeGlobal: true,
      });
      ragContext = formatContextForPrompt(chunks);
    }

    // 3. Web search
    progress('web_search', 10, 'Fetching latest information from the web…');
    let webContext = '';
    if (input.useWebSearch !== false) {
      const results = await webSearch(input.topic, { maxResults: 5 });
      webContext = formatSearchResultsForPrompt(results);
    }

    // 4. Generate outlines
    progress('generating_outlines', 15, 'Generating course structure…');
    const numScenes = input.numScenes ?? 16;
    const outlines = await generateOutlines({
      topic: input.topic,
      level: input.level,
      language: input.language,
      numScenes,
      ragContext,
      webContext,
      highQuality: input.highQuality,
    });

    progress('generating_scenes', 20, `Generating ${outlines.length} scenes…`, {
      scenesComplete: 0,
      totalScenes: outlines.length,
      courseId,
    });

    // 5. Generate scenes in parallel (controlled concurrency)
    const { getGenerationConfig } = await import('@/lib/db/config');
    const genConfig = await getGenerationConfig();
    const concurrency = genConfig.concurrencyLimit;

    const scenes: GeneratedScene[] = new Array(outlines.length);
    let completed = 0;

    // Process in batches of `concurrency`
    for (let i = 0; i < outlines.length; i += concurrency) {
      const batch = outlines.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (outline, batchIdx) => {
          const sceneIdx = i + batchIdx;
          const scene = await generateScene(outline, {
            allOutlines: outlines,
            sceneIndex: sceneIdx,
            topic: input.topic,
            level: input.level,
            language: input.language,
            ragContext,
            webContext,
            highQuality: input.highQuality,
          });
          scenes[sceneIdx] = scene;
          completed++;
          progress(
            'generating_scenes',
            20 + Math.round((completed / outlines.length) * 60),
            `Scene ${completed}/${outlines.length}: ${scene.title}`,
            {
              scenesComplete: completed,
              totalScenes: outlines.length,
              courseId,
            },
          );
        }),
      );
    }

    // 6. Pre-render TTS audio
    progress('rendering_audio', 80, 'Pre-rendering audio narration…');
    await renderTTSAudio(scenes, packageDir, (done, total) => {
      progress(
        'rendering_audio',
        80 + Math.round((done / total) * 15),
        `Audio ${done}/${total} scenes`,
      );
    });

    // 7. Save course package
    progress('saving', 95, 'Saving course package…');
    const courseTitle = outlines[0]?.title
      ? `${input.topic} — ${outlines.length} scenes`
      : input.topic;

    const packageData = {
      courseId,
      title: courseTitle,
      topic: input.topic,
      level: input.level,
      language: input.language,
      generatedAt: new Date().toISOString(),
      scenes,
    };

    fs.writeFileSync(
      path.join(packageDir, 'course.json'),
      JSON.stringify(packageData, null, 2),
      'utf-8',
    );

    // Update DB record
    await updateCourseRecord({
      id: courseId,
      title: courseTitle,
      sceneCount: scenes.length,
      status: 'ready',
    });

    progress('complete', 100, 'Course ready!', { courseId });
    log.info(`Course ${courseId} generated: ${scenes.length} scenes`);

    return { courseId, packagePath: packageDir, sceneCount: scenes.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Pre-generation failed:', err);

    await updateCourseRecord({ id: courseId, status: 'failed' }).catch(() => {});
    progress('error', 0, `Generation failed: ${message}`, { error: message, courseId });

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Outline generation
// ---------------------------------------------------------------------------

async function generateOutlines(opts: {
  topic: string;
  level?: string;
  language?: string;
  numScenes: number;
  ragContext: string;
  webContext: string;
  highQuality?: boolean;
}): Promise<SceneOutline[]> {
  const task = opts.highQuality ? 'generation-quality' : 'generation-draft';
  const { model, keyInfo } = await smartRouter.selectModel({ task });

  const contextSections = [opts.ragContext, opts.webContext].filter(Boolean).join('\n\n');
  const systemPrompt = `You are an expert course author and subject-matter specialist who writes deep, rigorous classes — the equivalent of a strong textbook chapter taught by an expert tutor.${opts.level ? ` Target level: ${opts.level}.` : ''}

${loadSnippet('teaching-depth')}`;

  const userPrompt = `Design a ${opts.numScenes}-scene deep-dive course on: "${opts.topic}"
${contextSections ? `\n${contextSections}\n` : ''}
## How to plan it

1. First, silently list every concrete sub-skill / technique / feature that mastery of this topic requires. Be complete — don't stop at category names.
2. Spread them over the ${opts.numScenes} scenes so each scene teaches ONE narrow idea in depth. If there are more sub-skills than scenes, prioritise the most important and go deep on them rather than skimming all of them.
3. Give each sub-skill a teaching arc: concept (precise rule + why it works) → fully worked example(s) → pitfalls → learner practice. Use "interactive" scenes for hands-on build-along / practice labs and "quiz" scenes (roughly every 4-5 scenes) for applied checks.
4. For programming topics, pick a running project the learner builds step by step across the course and advance it in the interactive scenes.
5. First scene: short orientation (what will be mastered, prerequisites, how to practise). Last scene: a mixed practice set or final build step — not a generic summary.

## Output

Return ONLY a JSON array of exactly ${opts.numScenes} objects:
{
  "id": "scene_N",
  "title": "Specific title (e.g. 'Multiplying by 11: the split-and-insert rule', not 'Multiplication tricks')",
  "type": "slides" | "quiz" | "interactive",
  "keyPoints": ["4-8 points that contain the ACTUAL content: the precise rule, a concrete worked example, a pitfall — never bare topic names"],
  "teachingNotes": "100-250 words: the exact rule/syntax, 1-2 fully worked examples with real numbers or real code, the main pitfall with a counter-example, and the practice exercise with its full solution. This is what the scene writer will expand, so be specific.",
  "speakerNotes": "One sentence describing the scene's goal"
}

Depth check before answering: could a learner pick up the actual technique from keyPoints + teachingNotes alone? If any keyPoint only names a topic, rewrite it to teach it.
${opts.language && opts.language !== 'en' ? `All content must be in language code: ${opts.language}` : ''}`;

  const { text, usage } = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    maxOutputTokens: OUTLINE_MAX_OUTPUT_TOKENS,
  });
  await smartRouter.recordUsage(keyInfo, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0);

  const parsed = parseJsonResponse<SceneOutline[]>(text);
  if (!parsed || !Array.isArray(parsed)) {
    throw new Error('Failed to parse scene outlines from LLM response');
  }
  return parsed.map((o, i) => ({
    ...o,
    id: o.id || `scene_${i + 1}`,
    keyPoints: Array.isArray(o.keyPoints) ? o.keyPoints : [],
    type: (['slides', 'quiz', 'interactive'] as const).includes(o.type) ? o.type : 'slides',
  }));
}

// ---------------------------------------------------------------------------
// Scene generation
// ---------------------------------------------------------------------------

async function generateScene(
  outline: SceneOutline,
  opts: {
    allOutlines: SceneOutline[];
    sceneIndex: number;
    topic: string;
    level?: string;
    language?: string;
    ragContext: string;
    webContext: string;
    highQuality?: boolean;
  },
): Promise<GeneratedScene> {
  const task = opts.highQuality ? 'generation-quality' : 'generation-draft';
  const { model, keyInfo } = await smartRouter.selectModel({ task });

  const courseMap = opts.allOutlines
    .map((o, i) => `${i + 1}. ${o.title}${i === opts.sceneIndex ? '   ← THIS SCENE' : ''}`)
    .join('\n');
  const prev = opts.sceneIndex > 0 ? opts.allOutlines[opts.sceneIndex - 1] : undefined;
  const prevSummary = prev
    ? `Previous scene ("${prev.title}") covered:\n- ${prev.keyPoints.join('\n- ')}${prev.teachingNotes ? `\n${prev.teachingNotes}` : ''}`
    : 'This is the first scene of the course.';

  const typeInstructions: Record<string, string> = {
    slides: `Teach this scene's idea in depth across 3-8 slides. Typical flow: precise rule/mechanism and why it works → fully worked example(s) with every step → edge cases & pitfalls → a "Your turn" exercise. Each slide needs a real "explanation" (1-3 paragraphs that teach, not tease). Use "code" for any programming content (complete, idiomatic, compilable code, with "output" showing results / inferred types / compiler errors). Use "steps" for worked calculations, one step per entry showing the operation and intermediate result. Always include an "exercise" with a full worked "solution".`,
    quiz: `Write 4-6 questions that make the learner APPLY what was taught in the preceding scenes to fresh problems: compute with the taught method, predict output/inferred types, find the bug, choose the right technique. No trivia or "which is a benefit of" questions. Use new numbers/code, not the slide examples. Each "explanation" must show the full worked solution and why the distractors are wrong.`,
    interactive: `Write a hands-on build-along / practice lab. The learner follows along on their own machine or paper. Give 4-10 concrete steps; each step has a precise "instruction", the exact "code" to write or problem to solve (if any), and "expected" — what they should see or get (output, inferred type, compiler error, answer). End with a stretch challenge and its solution. For programming topics, advance the course's running project.`,
  };

  const system = `You are an expert teacher writing one scene of a deep, rigorous course on "${opts.topic}"${opts.level ? ` (${opts.level} level)` : ''}.

${loadSnippet('teaching-depth')}`;

  const prompt = `## Course map
${courseMap}

## Continuity
${prevSummary}
Build on earlier scenes; don't re-teach them. Don't greet or re-introduce the course unless this is scene 1.

## This scene
Title: ${outline.title}
Type: ${outline.type}
Key points to teach (expand each fully):
- ${outline.keyPoints.join('\n- ')}
Teaching notes:
${outline.teachingNotes || '(none — derive concrete rules, fully worked examples and an exercise from the key points)'}
${opts.ragContext ? `\n## Reference material\n${opts.ragContext}\n` : ''}
## Instructions
${typeInstructions[outline.type] || typeInstructions.slides}

"speakerNotes" is the full spoken lecture for this scene: 300-800 words that walk through the material as an expert tutor would — explain the reasoning, talk through each worked example step by step, call out the pitfalls, tell the learner when to pause and try the exercise, then walk through the solution. No filler.

## Output
Return ONLY a valid JSON object (escape newlines inside strings as \\n, escape double quotes inside code):
{
  "title": "${outline.title.replace(/"/g, '\\"')}",
  "type": "${outline.type}",
  "speakerNotes": "...",
  "content": ${
    outline.type === 'quiz'
      ? `{ "questions": [{ "question": "...", "code": "optional code snippet the question refers to", "options": ["...", "...", "...", "..."], "correct": 0, "explanation": "full worked solution" }] }`
      : outline.type === 'interactive'
        ? `{ "activity": "what the learner will build/practise and why", "steps": [{ "instruction": "...", "code": "optional exact code or problem", "expected": "what they should see/get" }], "challenge": { "prompt": "...", "solution": "...", "solutionCode": "optional" }, "outcomes": ["concrete skill gained"] }`
        : `{ "slides": [{ "heading": "...", "explanation": "1-3 paragraphs that actually teach", "bullets": ["optional precise points"], "steps": ["optional worked-calculation steps"], "code": { "language": "ts", "code": "optional complete code", "caption": "optional" }, "output": "optional output / inferred type / compiler error", "example": "optional short example" }], "exercise": { "prompt": "the task", "starterCode": "optional", "hints": ["optional"], "solution": "full worked solution", "solutionCode": "optional" }, "keyTakeaways": ["the precise rules to remember"] }`
  }
}
${opts.language && opts.language !== 'en' ? `All content in language: ${opts.language}` : ''}`;

  const { text, usage } = await generateText({
    model,
    system,
    prompt,
    maxOutputTokens: SCENE_MAX_OUTPUT_TOKENS,
  });
  await smartRouter.recordUsage(keyInfo, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0);

  const parsed = parseJsonResponse<Omit<GeneratedScene, 'id'>>(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Failed to parse scene content for ${outline.id}`);
  }

  return {
    id: outline.id,
    title: parsed.title || outline.title,
    type: parsed.type || outline.type,
    content: (parsed.content as Record<string, unknown>) || {},
    speakerNotes: parsed.speakerNotes || outline.speakerNotes,
  };
}

// ---------------------------------------------------------------------------
// TTS Pre-rendering
// ---------------------------------------------------------------------------

async function renderTTSAudio(
  scenes: GeneratedScene[],
  packageDir: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const { getTTSConfig } = await import('@/lib/db/config');
  const ttsConfig = await getTTSConfig();

  const audioDir = path.join(packageDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });

  let done = 0;
  for (const scene of scenes) {
    if (!scene.speakerNotes?.trim()) {
      done++;
      onProgress?.(done, scenes.length);
      continue;
    }

    try {
      const audioPath = path.join(audioDir, `${scene.id}.mp3`);

      const res = await fetch(`${ttsConfig.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ttsConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: 'kokoro',
          input: scene.speakerNotes,
          voice: ttsConfig.defaultVoice,
          response_format: 'mp3',
        }),
        // Long lecture narration takes a while to synthesise locally
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      });

      if (res.ok) {
        const buffer = await res.arrayBuffer();
        fs.writeFileSync(audioPath, Buffer.from(buffer));
        scene.audioPath = `audio/${scene.id}.mp3`;
        log.info(`  TTS rendered: ${scene.id}`);
      } else {
        log.warn(`  TTS failed for scene ${scene.id}: HTTP ${res.status}`);
      }
    } catch (err) {
      log.warn(`  TTS error for scene ${scene.id}:`, err);
    }

    done++;
    onProgress?.(done, scenes.length);
  }
}

// ---------------------------------------------------------------------------
// Tag matching — extract likely tags from topic by matching against known tags
// ---------------------------------------------------------------------------

async function matchTopicToTags(topic: string): Promise<string[]> {
  try {
    const { db } = await import('@/lib/db');
    const { knowledgeDoc } = await import('@/lib/db/schema');

    const rows = await db.selectDistinct({ tags: knowledgeDoc.tags }).from(knowledgeDoc);

    // Collect all unique tags from the database
    const allTags = new Set<string>();
    for (const row of rows) {
      if (row.tags) {
        for (const t of row.tags.split(',')) {
          const tag = t.trim().toLowerCase();
          if (tag) allTags.add(tag);
        }
      }
    }

    if (allTags.size === 0) return [];

    // Match topic words/phrases against available tags
    const topicLower = topic.toLowerCase();
    const topicWords = topicLower.split(/[\s,.\-—:;()[\]]+/).filter((w) => w.length >= 2);

    const matched: string[] = [];
    for (const tag of allTags) {
      // Direct substring match: tag appears in topic, or a topic word matches the tag
      if (topicLower.includes(tag) || topicWords.some((w) => tag.includes(w) || w.includes(tag))) {
        matched.push(tag);
      }
    }

    return matched;
  } catch (err) {
    log.warn('Failed to match topic to tags:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function registerCourse(data: {
  id: string;
  userId: string;
  topic: string;
  level?: string;
  packagePath: string;
  status: string;
}): Promise<void> {
  const { db } = await import('@/lib/db');
  const { course } = await import('@/lib/db/schema');

  await db.insert(course).values({
    id: data.id,
    userId: data.userId,
    title: data.topic,
    topic: data.topic,
    level: data.level,
    sceneCount: 0,
    packagePath: data.packagePath,
    status: data.status,
    generationCostUsd: 0,
  });
}

async function updateCourseRecord(data: {
  id: string;
  title?: string;
  sceneCount?: number;
  status?: string;
}): Promise<void> {
  const { db } = await import('@/lib/db');
  const { course } = await import('@/lib/db/schema');
  const { eq } = await import('drizzle-orm');

  await db
    .update(course)
    .set({
      ...(data.title != null && { title: data.title }),
      ...(data.sceneCount != null && { sceneCount: data.sceneCount }),
      ...(data.status != null && { status: data.status }),
    })
    .where(eq(course.id, data.id));
}
