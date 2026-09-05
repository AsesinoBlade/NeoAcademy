/**
 * Scene Content Generation API
 *
 * Generates scene content (slides/quiz/interactive/pbl) from an outline.
 * This is the first half of the two-step scene generation pipeline.
 * Does NOT generate actions — use /api/generate/scene-actions for that.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import {
  applyOutlineFallbacks,
  generateSceneContent,
  buildVisionUserContent,
} from '@/lib/generation/generation-pipeline';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import type { SceneOutline, PdfImage, ImageMapping } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';

const log = createLogger('Scene Content API');

export const maxDuration = 1800;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      outline: rawOutline,
      allOutlines,
      pdfImages,
      imageMapping,
      stageInfo,
      stageId,
      agents,
    } = body as {
      outline: SceneOutline;
      allOutlines: SceneOutline[];
      pdfImages?: PdfImage[];
      imageMapping?: ImageMapping;
      stageInfo: {
        name: string;
        description?: string;
        language?: string;
        style?: string;
      };
      stageId: string;
      agents?: AgentInfo[];
    };

    // Validate required fields
    if (!rawOutline) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
    }
    if (!allOutlines || allOutlines.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'allOutlines is required and must not be empty',
      );
    }
    if (!stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }

    // Ensure outline has language from stageInfo (fallback for older outlines)
    const outline: SceneOutline = {
      ...rawOutline,
      language: rawOutline.language || (stageInfo?.language as 'zh-CN' | 'en-US') || 'zh-CN',
    };

    // ── Model resolution from request headers ──
    const { model: languageModel, modelInfo, modelString } = resolveModelFromHeaders(req);

    // Detect vision capability
    const hasVision = !!modelInfo?.capabilities?.vision;

    const configuredSceneOutputTokens = Number.parseInt(
      process.env.SCENE_CONTENT_MAX_OUTPUT_TOKENS || '16384',
      10,
    );

    const maxSceneOutputTokens = Math.min(
      modelInfo?.outputWindow ?? configuredSceneOutputTokens,
      configuredSceneOutputTokens,
    );

    const logTokenUsage = (result: {
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
    }) => {
      const outputTokens = result.usage?.outputTokens;
      const inputTokens = result.usage?.inputTokens;
      const totalTokens = result.usage?.totalTokens;

      if (typeof outputTokens !== 'number') {
        log.info('Scene content token usage unavailable from provider');
        return;
      }

      const percent = ((outputTokens / maxSceneOutputTokens) * 100).toFixed(1);

      log.info(
        `Scene content tokens: output=${outputTokens}/${maxSceneOutputTokens} (${percent}%), input=${inputTokens ?? 'unknown'}, total=${totalTokens ?? 'unknown'}`,
      );
    };

    // Vision-aware AI call function
    const aiCall = async (
      systemPrompt: string,
      userPrompt: string,
      images?: Array<{ id: string; src: string }>,
    ): Promise<string> => {
      if (images?.length && hasVision) {
        const result = await callLLM(
          {
            model: languageModel,
            system: systemPrompt,
            messages: [
              {
                role: 'user' as const,
                content: buildVisionUserContent(userPrompt, images),
              },
            ],
            maxOutputTokens: maxSceneOutputTokens,
          },
          'scene-content',
        );
        logTokenUsage(result);
        return result.text;
      }
      const result = await callLLM(
        {
          model: languageModel,
          system: systemPrompt,
          prompt: userPrompt,
          maxOutputTokens: maxSceneOutputTokens,
        },
        'scene-content',
      );
      logTokenUsage(result);
      return result.text;
    };

    // ── Apply fallbacks ──
    const effectiveOutline = applyOutlineFallbacks(outline, !!languageModel);

    // ── Filter images assigned to this outline ──
    let assignedImages: PdfImage[] | undefined;
    if (
      pdfImages &&
      pdfImages.length > 0 &&
      effectiveOutline.suggestedImageIds &&
      effectiveOutline.suggestedImageIds.length > 0
    ) {
      const suggestedIds = new Set(effectiveOutline.suggestedImageIds);
      assignedImages = pdfImages.filter((img) => suggestedIds.has(img.id));
    }

    // ── Media generation is handled client-side in parallel (media-orchestrator.ts) ──
    // The content generator receives placeholder IDs (gen_img_1, gen_vid_1) as-is.
    // resolveImageIds() in generation-pipeline.ts will keep these placeholders in elements.
    const generatedMediaMapping: ImageMapping = {};

    // ── Generate content ──
    log.info(
      `Generating content: "${effectiveOutline.title}" (${effectiveOutline.type}) [model=${modelString}]`,
    );

    const content = await generateSceneContent(
      effectiveOutline,
      aiCall,
      assignedImages,
      imageMapping,
      effectiveOutline.type === 'pbl' ? languageModel : undefined,
      hasVision,
      generatedMediaMapping,
      agents,
    );

    if (!content) {
      log.error(`Failed to generate content for: "${effectiveOutline.title}"`);

      return apiError(
        'GENERATION_FAILED',
        500,
        `Failed to generate content: ${effectiveOutline.title}`,
      );
    }

    log.info(`Content generated successfully: "${effectiveOutline.title}"`);

    return apiSuccess({ content, effectiveOutline });
  } catch (error) {
    log.error('Scene content generation error:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
