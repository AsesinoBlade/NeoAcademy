/**
 * Scene Outlines Streaming API (SSE)
 *
 * Streams outline generation via Server-Sent Events.
 * Emits individual outline objects as they're parsed from the LLM response,
 * so the frontend can display them incrementally.
 *
 * SSE events:
 *   { type: 'outline', data: SceneOutline, index: number }
 *   { type: 'done', outlines: SceneOutline[] }
 *   { type: 'error', error: string }
 */

import { NextRequest } from 'next/server';
import { streamLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import {
  formatImageDescription,
  formatImagePlaceholder,
  buildVisionUserContent,
  uniquifyMediaElementIds,
  formatTeacherPersonaForPrompt,
} from '@/lib/generation/generation-pipeline';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import { MAX_SOURCE_TEXT_CHARS, MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { nanoid } from 'nanoid';
import type {
  UserRequirements,
  PdfImage,
  SceneOutline,
  ImageMapping,
} from '@/lib/types/generation';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { resolveGenerationModelFromHeaders } from '@/lib/server/resolve-model';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const log = createLogger('Outlines Stream');

export const maxDuration = 300;

function isSceneOutlineCandidate(value: unknown): value is SceneOutline {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<SceneOutline>;

  return (
    typeof candidate.title === 'string' &&
    candidate.title.trim().length > 0 &&
    typeof candidate.description === 'string' &&
    Array.isArray(candidate.keyPoints) &&
    candidate.keyPoints.length > 0 &&
    ['slide', 'quiz', 'interactive', 'pbl', 'chapter'].includes(candidate.type || '')
  );
}

/**
 * Incremental JSON array parser.
 * Extracts complete top-level outline objects from the first top-level JSON array.
 * Nested objects inside mediaGenerations/quizConfig/etc. are ignored.
 */
function extractNewOutlines(buffer: string, alreadyParsed: number): SceneOutline[] {
  const results: SceneOutline[] = [];

  // Skip any prose/markdown before the first array.
  const arrayStart = buffer.indexOf('[');
  if (arrayStart === -1) return results;

  let arrayDepth = 0;
  let objectDepth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  let validOutlineCount = 0;

  for (let i = arrayStart; i < buffer.length; i++) {
    const char = buffer[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '[') {
      arrayDepth++;
      continue;
    }

    if (char === ']') {
      arrayDepth--;
      if (arrayDepth === 0) break;
      continue;
    }

    // Only capture objects directly inside the outermost array.
    if (arrayDepth === 1 && char === '{') {
      if (objectDepth === 0) {
        objectStart = i;
      }
      objectDepth++;
      continue;
    }

    if (arrayDepth === 1 && char === '}') {
      objectDepth--;

      if (objectDepth === 0 && objectStart >= 0) {
        try {
          const obj = JSON.parse(buffer.substring(objectStart, i + 1));

          if (isSceneOutlineCandidate(obj)) {
            validOutlineCount++;

            if (validOutlineCount > alreadyParsed) {
              results.push(obj);
            }
          }
        } catch {
          // Incomplete or invalid JSON — wait for more streamed text.
        }

        objectStart = -1;
      }
    }
  }

  return results;
}
/**
 * Second pass over a finished stream. The incremental parser tracks string
 * boundaries character by character, so a stray unescaped quote in one
 * outline makes it drop that outline (or everything after it). Re-parse the
 * whole text with the repairing JSON parser and return any valid outlines
 * whose titles we don't already have.
 */
function recoverMissedOutlines(text: string, knownTitles: Set<string>): SceneOutline[] {
  const parsed = parseJsonResponse<unknown>(text);
  const list = Array.isArray(parsed) ? parsed : [];
  const recovered: SceneOutline[] = [];
  for (const item of list) {
    if (!isSceneOutlineCandidate(item)) continue;
    const key = item.title.trim().toLowerCase();
    if (knownTitles.has(key)) continue;
    knownTitles.add(key);
    recovered.push(item);
  }
  return recovered;
}

/** Keep the raw model output when an outline comes back suspiciously small. */
async function saveOutlineDebug(text: string, label: string): Promise<string | null> {
  try {
    const dir = path.join(process.cwd(), 'data', 'classroom-logs');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `outline-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    await fs.writeFile(file, text, 'utf-8');
    return file;
  } catch {
    return null;
  }
}

/** A deep-dive book needs many chapters; fewer means the model stopped early. */
const MIN_BOOK_CHAPTERS = 8;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Get API configuration from request headers
    const { model: languageModel, modelInfo, modelString } = resolveGenerationModelFromHeaders(req);

    if (!body.requirements) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Requirements are required');
    }

    const { requirements, pdfText, pdfImages, imageMapping, researchContext, agents, revision, mode, premises } =
      body as {
        /** Ebooks: premise check results the plan must follow. */
        premises?: import('@/lib/book/principles').PremiseFinding[];
        /** 'ebook' plans a book (chapters → sections) instead of a class. */
        mode?: 'class' | 'ebook';
        requirements: UserRequirements;
        pdfText?: string;
        pdfImages?: PdfImage[];
        imageMapping?: ImageMapping;
        researchContext?: string;
        agents?: AgentInfo[];
        /** Revise an existing outline according to the user's notes. */
        revision?: {
          previousOutlines: SceneOutline[];
          feedback: string;
        };
      };

    // Detect vision capability
    const hasVision = !!modelInfo?.capabilities?.vision;

    // Build prompt (same logic as generateSceneOutlinesFromRequirements)
    let availableImagesText =
      requirements.language === 'zh-CN' ? '无可用图片' : 'No images available';
    let visionImages: Array<{ id: string; src: string }> | undefined;

    if (pdfImages && pdfImages.length > 0) {
      if (hasVision && imageMapping) {
        // Vision mode: split into vision images (first N) and text-only (rest)
        const allWithSrc = pdfImages.filter((img) => imageMapping[img.id]);
        const visionSlice = allWithSrc.slice(0, MAX_VISION_IMAGES);
        const textOnlySlice = allWithSrc.slice(MAX_VISION_IMAGES);
        const noSrcImages = pdfImages.filter((img) => !imageMapping[img.id]);

        const visionDescriptions = visionSlice.map((img) =>
          formatImagePlaceholder(img, requirements.language),
        );
        const textDescriptions = [...textOnlySlice, ...noSrcImages].map((img) =>
          formatImageDescription(img, requirements.language),
        );
        availableImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

        visionImages = visionSlice.map((img) => ({
          id: img.id,
          src: imageMapping[img.id],
          width: img.width,
          height: img.height,
        }));
      } else {
        // Text-only mode: full descriptions
        availableImagesText = pdfImages
          .map((img) => formatImageDescription(img, requirements.language))
          .join('\n');
      }
    }

    // Build media generation policy based on enabled flags
    const imageGenerationEnabled = req.headers.get('x-image-generation-enabled') === 'true';
    const videoGenerationEnabled = req.headers.get('x-video-generation-enabled') === 'true';
    let mediaGenerationPolicy = '';
    if (!imageGenerationEnabled && !videoGenerationEnabled) {
      mediaGenerationPolicy =
        '**IMPORTANT: Do NOT include any mediaGenerations in the outlines. Both image and video generation are disabled.**';
    } else if (!imageGenerationEnabled) {
      mediaGenerationPolicy =
        '**IMPORTANT: Do NOT include any image mediaGenerations (type: "image") in the outlines. Image generation is disabled. Video generation is allowed.**';
    } else if (!videoGenerationEnabled) {
      mediaGenerationPolicy =
        '**IMPORTANT: Do NOT include any video mediaGenerations (type: "video") in the outlines. Video generation is disabled. Image generation is allowed.**';
    }

    // Build teacher context from agents (if available)
    const teacherContext = formatTeacherPersonaForPrompt(agents);

    const userProfileText =
      requirements.userNickname || requirements.userBio
        ? `## Reader Profile\n\nReader: ${requirements.userNickname || 'Unknown'}${requirements.userBio ? ` — ${requirements.userBio}` : ''}\n\nAdapt depth, examples and assumed background to this reader.\n\n---`
        : '';

    const prompts =
      mode === 'ebook'
        ? buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_BOOK_OUTLINE, {
            requirement: requirements.requirement,
            language: requirements.language,
            pdfContent: pdfText ? pdfText.substring(0, MAX_SOURCE_TEXT_CHARS) : 'None',
            researchContext: researchContext || 'None',
            userProfile: userProfileText,
            imagePolicy: imageGenerationEnabled
              ? 'available — generated illustrations and photo-realistic pictures, for things that need no readable text or exact detail (equipment, settings, people, historical scenes, conceptual illustrations). Image models cannot render text, so never plan pictures of screenshots, user interfaces, file/directory trees, code, diagrams, grids, tables or anything with numbers or labels — plan code blocks, Mermaid diagrams, tables or charts for those. Also give the FIRST chapter a "coverImagePrompt": a description of an elegant, text-free cover illustration for the book.'
              : 'NOT available (image generation is disabled) — do not plan pictures; rely on charts, diagrams and tables.',
          })
        : buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
      requirement: requirements.requirement,
      language: requirements.language,
      pdfContent: pdfText
        ? pdfText.substring(0, MAX_SOURCE_TEXT_CHARS)
        : requirements.language === 'zh-CN'
          ? '无'
          : 'None',
      availableImages: availableImagesText,
      researchContext: researchContext || (requirements.language === 'zh-CN' ? '无' : 'None'),
      mediaGenerationPolicy,
      teacherContext,
      userProfile:
        requirements.userNickname || requirements.userBio
          ? `## Student Profile\n\nStudent: ${requirements.userNickname || 'Unknown'}${requirements.userBio ? ` — ${requirements.userBio}` : ''}\n\nConsider this student's background when designing the course. Adapt difficulty, examples, and teaching approach accordingly.\n\n---`
          : '',
    });

    if (!prompts) {
      return apiError('INTERNAL_ERROR', 500, 'Prompt template not found');
    }

    // Ebooks: plan with the premise check's editorial stance, so unsupported
    // ideas in the request are explained and corrected rather than taught.
    if (mode === 'ebook' && Array.isArray(premises) && premises.length > 0) {
      const { formatPremises } = await import('@/lib/book/principles');
      prompts.user +=
        `\n\n## Premise check of the request (follow this editorial stance)\n\n${formatPremises(premises)}\n\n` +
        `Plan the book accordingly: premises marked UNSUPPORTED or FALSE must not become techniques the book teaches. ` +
        `Give them sections that explain why the idea is popular, what the evidence and mathematics actually show, ` +
        `and what the reader can genuinely do instead. CONTESTED premises are presented with the evidence on each side.`;
    }

    // Revision mode: the user reviewed (and possibly hand-edited) an outline
    // and wrote notes. Give the model the current outline plus the notes and
    // ask for a full revised outline — keeping what the notes don't touch.
    if (revision?.previousOutlines?.length && revision.feedback?.trim()) {
      const currentOutline = revision.previousOutlines.map((outline, index) => ({
        order: index + 1,
        type: outline.type,
        title: outline.title,
        description: outline.description,
        keyPoints: outline.keyPoints,
        teachingNotes: outline.teachingNotes,
        ...(outline.quizConfig ? { quizConfig: outline.quizConfig } : {}),
        ...(outline.bookTitle ? { bookTitle: outline.bookTitle } : {}),
        ...(outline.bookSubtitle ? { bookSubtitle: outline.bookSubtitle } : {}),
        ...(outline.coverImagePrompt ? { coverImagePrompt: outline.coverImagePrompt } : {}),
        ...(outline.mediaGenerations?.length ? { mediaGenerations: outline.mediaGenerations } : {}),
      }));

      prompts.user +=
        `\n\n## REVISION REQUEST (highest priority)\n\n` +
        `You already produced an outline for this course, and the learner has reviewed it ` +
        `(some scenes may have been edited, reordered or deleted by hand — treat the version below as the current state).\n\n` +
        `### Current outline\n\n\`\`\`json\n${JSON.stringify(currentOutline, null, 2)}\n\`\`\`\n\n` +
        `### Learner's notes\n\n${revision.feedback.trim()}\n\n` +
        `### How to revise\n\n` +
        `- Apply every note fully: add, split, merge, reorder, deepen or remove scenes as the notes require.\n` +
        `- Keep scenes the notes do not affect, including their hand-edited wording, unless a change elsewhere requires adjusting them (e.g. renumbering, updated cross-references).\n` +
        `- All the depth and format rules above still apply to new or changed scenes.\n` +
        `- Output the COMPLETE revised outline as one JSON array (every scene, not just the changed ones).`;

      log.info(
        `Revising outline (${revision.previousOutlines.length} scenes) with notes: "${revision.feedback.trim().slice(0, 120)}"`,
      );
    }

    log.info(
      `Generating outlines: "${requirements.requirement.substring(0, 50)}" [model=${modelString}]`,
    );

    // Create SSE stream with heartbeat to prevent connection timeout
    const encoder = new TextEncoder();
    const HEARTBEAT_INTERVAL_MS = 15_000;
    const stream = new ReadableStream({
      async start(controller) {
        // Heartbeat: periodically send SSE comments to keep the connection alive.
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        const startHeartbeat = () => {
          stopHeartbeat();
          heartbeatTimer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`:heartbeat\n\n`));
            } catch {
              stopHeartbeat();
            }
          }, HEARTBEAT_INTERVAL_MS);
        };
        const stopHeartbeat = () => {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        };

        const MAX_STREAM_RETRIES = 2;

        try {
          startHeartbeat();

          const streamParams = visionImages?.length
            ? {
                model: languageModel,
                system: prompts.system,
                messages: [
                  {
                    role: 'user' as const,
                    content: buildVisionUserContent(prompts.user, visionImages),
                  },
                ],
                maxOutputTokens: modelInfo?.outputWindow,
              }
            : {
                model: languageModel,
                system: prompts.system,
                prompt: prompts.user,
                maxOutputTokens: modelInfo?.outputWindow,
              };

          let parsedOutlines: SceneOutline[] = [];
          let lastError: string | undefined;
          let lastFullText = '';
          let lastFinishReason: string | undefined;

          for (let attempt = 1; attempt <= MAX_STREAM_RETRIES + 1; attempt++) {
            try {
              const result = streamLLM(streamParams, 'scene-outlines-stream');

              let fullText = '';
              parsedOutlines = [];

              for await (const chunk of result.textStream) {
                fullText += chunk;

                // Try to extract new outlines from the accumulated text
                const newOutlines = extractNewOutlines(fullText, parsedOutlines.length);
                for (const outline of newOutlines) {
                  // Ensure ID and order
                  const enriched = {
                    ...outline,
                    id: outline.id || nanoid(),
                    order: parsedOutlines.length + 1,
                  };
                  parsedOutlines.push(enriched);

                  const event = JSON.stringify({
                    type: 'outline',
                    data: enriched,
                    index: parsedOutlines.length - 1,
                  });
                  controller.enqueue(encoder.encode(`data: ${event}\n\n`));
                }
              }

              // Recover outlines the incremental parser missed (stray quotes).
              {
                const known = new Set(parsedOutlines.map((o) => o.title.trim().toLowerCase()));
                for (const outline of recoverMissedOutlines(fullText, known)) {
                  const enriched = { ...outline, id: outline.id || nanoid(), order: parsedOutlines.length + 1 };
                  parsedOutlines.push(enriched);
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ type: 'outline', data: enriched, index: parsedOutlines.length - 1 })}\n\n`,
                    ),
                  );
                  log.warn(`Recovered outline missed by the stream parser: "${enriched.title}"`);
                }
              }

              lastFullText = fullText;
              try {
                lastFinishReason = String(await result.finishReason);
              } catch {
                lastFinishReason = undefined;
              }

              // Validate: got outlines?
              if (parsedOutlines.length > 0) break;

              // Empty result — retry if we have attempts left
              lastError = fullText.trim()
                ? 'LLM response could not be parsed into outlines'
                : 'LLM returned empty response';

              if (attempt <= MAX_STREAM_RETRIES) {
                log.warn(
                  `Empty outlines (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}), retrying...`,
                );
                // Notify client a retry is happening
                const retryEvent = JSON.stringify({
                  type: 'retry',
                  attempt,
                  maxAttempts: MAX_STREAM_RETRIES + 1,
                });
                controller.enqueue(encoder.encode(`data: ${retryEvent}\n\n`));
              }
            } catch (error) {
              lastError = error instanceof Error ? error.message : String(error);

              if (attempt <= MAX_STREAM_RETRIES) {
                log.warn(
                  `Stream error (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}), retrying...`,
                  error,
                );
                const retryEvent = JSON.stringify({
                  type: 'retry',
                  attempt,
                  maxAttempts: MAX_STREAM_RETRIES + 1,
                });
                controller.enqueue(encoder.encode(`data: ${retryEvent}\n\n`));
                continue;
              }
            }
          }

          // Truncation recovery: deep courses produce long outlines, and a
          // local model can hit its output/context limit mid-course. If the
          // JSON array never closed (or the model reports a length stop), ask
          // it to continue from the next scene instead of silently shipping
          // a course with no ending.
          // Books may need several continuations if the model writes a few
          // chapters per response; classes only ever need to finish a cut-off.
          const MAX_CONTINUATIONS = mode === 'ebook' ? 6 : 2;
          const looksTruncated = (text: string, finishReason?: string) =>
            finishReason === 'length' ||
            !/\]\s*(```)?\s*$/.test(text.trim()) ||
            // A closed array is not proof of completeness for a book: a model
            // that copies a one-item example will close the array after it.
            (mode === 'ebook' && parsedOutlines.length < MIN_BOOK_CHAPTERS);

          if (mode === 'ebook' && parsedOutlines.length > 0 && parsedOutlines.length < MIN_BOOK_CHAPTERS) {
            const debugFile = await saveOutlineDebug(lastFullText, 'book-short');
            log.warn(
              `Book outline has only ${parsedOutlines.length} chapter(s); asking the model to continue` +
                (debugFile ? ` (raw output saved to ${debugFile})` : ''),
            );
          }

          for (
            let continuation = 1;
            continuation <= MAX_CONTINUATIONS &&
            parsedOutlines.length > 0 &&
            looksTruncated(lastFullText, lastFinishReason);
            continuation++
          ) {
            log.warn(
              `Outline looks truncated after ${parsedOutlines.length} scenes ` +
                `(finishReason=${lastFinishReason ?? 'unknown'}); requesting continuation ${continuation}/${MAX_CONTINUATIONS}`,
            );

            const soFar = parsedOutlines
              .map((o) => `${o.order}. [${o.type}] ${o.title}`)
              .join('\n');
            const unit = mode === 'ebook' ? 'chapters' : 'scenes';
            const continuationPrompt =
              prompts.user +
              `\n\n## CONTINUATION REQUEST\n` +
              (mode === 'ebook' && parsedOutlines.length < MIN_BOOK_CHAPTERS
                ? `Your previous output stopped after only ${parsedOutlines.length} chapter(s), but this book needs ` +
                  `14–22 chapters covering everything the request asks for (every named technique/topic must get its own section). `
                : `Your previous output was cut off. `) +
              `These ${unit} already exist:\n${soFar}\n\n` +
              `Output ONLY a JSON array containing the REMAINING ${unit}, starting at ${mode === 'ebook' ? 'chapter' : 'scene'} ${parsedOutlines.length + 1} ` +
              `and continuing the same plan through to the course's final synthesis / capstone scene ` +
              `(including finishing any running project). Do not repeat any existing scene. ` +
              `Keep each teachingNotes concise (under 150 words) so the output completes.`;

            try {
              const contResult = streamLLM(
                {
                  model: languageModel,
                  system: prompts.system,
                  prompt: continuationPrompt,
                  maxOutputTokens: modelInfo?.outputWindow,
                },
                'scene-outlines-stream-continuation',
              );

              const existingTitles = new Set(parsedOutlines.map((o) => o.title.trim().toLowerCase()));
              let contText = '';
              let contParsed = 0;
              let added = 0;

              for await (const chunk of contResult.textStream) {
                contText += chunk;
                const newOutlines = extractNewOutlines(contText, contParsed);
                contParsed += newOutlines.length;

                for (const outline of newOutlines) {
                  if (existingTitles.has(String(outline.title).trim().toLowerCase())) continue;
                  existingTitles.add(String(outline.title).trim().toLowerCase());

                  const enriched = {
                    ...outline,
                    id: outline.id || nanoid(),
                    order: parsedOutlines.length + 1,
                  };
                  parsedOutlines.push(enriched);
                  added++;

                  const event = JSON.stringify({
                    type: 'outline',
                    data: enriched,
                    index: parsedOutlines.length - 1,
                  });
                  controller.enqueue(encoder.encode(`data: ${event}\n\n`));
                }
              }

              for (const outline of recoverMissedOutlines(contText, existingTitles)) {
                const enriched = { ...outline, id: outline.id || nanoid(), order: parsedOutlines.length + 1 };
                parsedOutlines.push(enriched);
                added++;
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: 'outline', data: enriched, index: parsedOutlines.length - 1 })}\n\n`,
                  ),
                );
              }

              lastFullText = contText;
              try {
                lastFinishReason = String(await contResult.finishReason);
              } catch {
                lastFinishReason = undefined;
              }

              log.info(`Outline continuation ${continuation} added ${added} scene(s)`);
              if (added === 0) break;
            } catch (error) {
              log.warn('Outline continuation failed; keeping the scenes generated so far', error);
              break;
            }
          }

          if (parsedOutlines.length > 0) {
            // Replace sequential gen_img_N/gen_vid_N with globally unique IDs
            const uniquifiedOutlines = uniquifyMediaElementIds(parsedOutlines);
            log.info(
              `Parsed outlines: ${uniquifiedOutlines
                .map((outline) => `${outline.order}:${outline.type}:${outline.title}`)
                .join(' | ')}`,
            );
            // Send done event with all outlines
            const doneEvent = JSON.stringify({
              type: 'done',
              outlines: uniquifiedOutlines,
            });
            controller.enqueue(encoder.encode(`data: ${doneEvent}\n\n`));
          } else {
            // All retries exhausted, no outlines produced
            log.error(
              `Outline generation failed after ${MAX_STREAM_RETRIES + 1} attempts: ${lastError}`,
            );
            const errorEvent = JSON.stringify({
              type: 'error',
              error: lastError || 'Failed to generate outlines',
            });
            controller.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
          }
        } catch (error) {
          const errorEvent = JSON.stringify({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          controller.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
        } finally {
          stopHeartbeat();
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    log.error('Streaming error:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
