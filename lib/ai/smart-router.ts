/**
 * Smart Model Router
 *
 * Selects the optimal LLM provider + model for a given task, respecting:
 * - Task type (generation vs runtime)
 * - Available providers / API keys
 * - Rate limit state
 * - Cost constraints
 * - Fallback chain: gemini-free → siliconflow → gemini-paid → openai
 *
 * Usage:
 *   const { model, keyInfo } = await smartRouter.selectModel({ task: 'generation-quality' });
 *   const result = await generateText({ model, ... });
 *   if (keyInfo) await smartRouter.recordUsage(keyInfo, tokensIn, tokensOut);
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { createLogger } from '@/lib/logger';
import { pickKey, markRateLimited, recordUsage as recordGeminiUsage } from './gemini-key-pool';

const log = createLogger('SmartRouter');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskType =
  | 'generation-draft' // Gemini Flash Lite (fast, cheap)
  | 'generation-quality' // Gemini Flash (higher quality scenes)
  | 'embedding' // Gemini embedding-001
  | 'runtime-chat' // Ollama local (free, instant)
  | 'runtime-grade' // Ollama local (quiz grading)
  | 'web-search-summary' // Ollama local (summarise search results)
  | 'tts' // Kokoro TTS
  | 'asr'; // Whisper ASR

export interface KeyInfo {
  keyHash: string;
  isPaid: boolean;
  provider: 'gemini' | 'siliconflow' | 'openai' | 'ollama';
}

export interface RouterResult {
  model: LanguageModel;
  keyInfo: KeyInfo;
  modelId: string;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

async function buildGeminiModel(
  modelId: string,
): Promise<{ model: LanguageModel; keyInfo: KeyInfo } | null> {
  const keyData = await pickKey();
  if (!keyData) return null;

  const gemini = createGoogleGenerativeAI({ apiKey: keyData.key });
  return {
    model: gemini(modelId) as LanguageModel,
    keyInfo: { keyHash: keyData.keyHash, isPaid: keyData.isPaid, provider: 'gemini' },
  };
}

async function buildSiliconFlowModel(
  modelId: string,
): Promise<{ model: LanguageModel; keyInfo: KeyInfo } | null> {
  const { getSiliconFlowConfig } = await import('@/lib/db/config');
  const config = await getSiliconFlowConfig();
  if (!config.enabled || !config.apiKey) return null;

  const client = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  return {
    model: client(modelId) as LanguageModel,
    keyInfo: { keyHash: config.apiKey.slice(0, 8), isPaid: false, provider: 'siliconflow' },
  };
}

async function buildOllamaModel(
  modelId: string,
): Promise<{ model: LanguageModel; keyInfo: KeyInfo }> {
  const { getOllamaConfig } = await import('@/lib/db/config');
  const config = await getOllamaConfig();

  const client = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  return {
    model: client(modelId) as LanguageModel,
    keyInfo: { keyHash: 'local', isPaid: false, provider: 'ollama' },
  };
}

async function buildOpenAIModel(
  modelId: string,
): Promise<{ model: LanguageModel; keyInfo: KeyInfo } | null> {
  const { getOpenAIConfig } = await import('@/lib/db/config');
  const config = await getOpenAIConfig();
  if (!config.enabled || !config.apiKey) return null;

  const client = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  return {
    model: client(modelId) as LanguageModel,
    keyInfo: { keyHash: config.apiKey.slice(0, 8), isPaid: true, provider: 'openai' },
  };
}

// ---------------------------------------------------------------------------
// Task → model mapping
// ---------------------------------------------------------------------------

async function resolveForTask(task: TaskType): Promise<RouterResult | null> {
  switch (task) {
    case 'generation-draft':
    case 'generation-quality': {
      const cfg = await import('@/lib/db/config').then((m) => m.getOllamaConfig());
      const result = await buildOllamaModel(cfg.model);
      return { ...result, modelId: cfg.model };
    }

    case 'runtime-chat':
    case 'runtime-grade':
    case 'web-search-summary': {
      const cfg = await import('@/lib/db/config').then((m) => m.getOllamaConfig());
      const result = await buildOllamaModel(cfg.model);
      return { ...result, modelId: cfg.model };
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const smartRouter = {
  /**
   * Select a model for the given task.
   * Tries providers in order until one succeeds.
   */
  async selectModel(opts: { task: TaskType }): Promise<RouterResult> {
    const result = await resolveForTask(opts.task);
    if (!result) {
      throw new Error(
        `No available provider for task "${opts.task}". Check API keys in the admin portal.`,
      );
    }
    log.info(
      `Router: task=${opts.task} → provider=${result.keyInfo.provider} model=${result.modelId}`,
    );
    return result;
  },

  /**
   * Call after a successful generation to record usage.
   */
  async recordUsage(keyInfo: KeyInfo, tokensIn: number, tokensOut: number): Promise<void> {
    if (keyInfo.provider === 'gemini') {
      await recordGeminiUsage(keyInfo.keyHash, tokensIn, tokensOut, keyInfo.isPaid);
    } else {
      // Record for other providers in the usage table
      persistProviderUsage(keyInfo.provider, keyInfo.keyHash, tokensIn, tokensOut).catch(() => {});
    }
  },

  /**
   * Call on 429 rate-limit error to rotate keys.
   */
  async onRateLimit(keyInfo: KeyInfo): Promise<void> {
    if (keyInfo.provider === 'gemini') {
      await markRateLimited(keyInfo.keyHash);
    }
  },
};

async function persistProviderUsage(
  provider: string,
  keyHash: string,
  tokensIn: number,
  tokensOut: number,
) {
  const { db } = await import('@/lib/db');
  const { providerUsage } = await import('@/lib/db/schema');

  // Approximate cost per provider
  const costPerMIn: Record<string, number> = {
    siliconflow: 0.02,
    openai: 0.05,
  };
  const costPerMOut: Record<string, number> = {
    siliconflow: 0.06,
    openai: 0.2,
  };
  const costUsd =
    (tokensIn / 1_000_000) * (costPerMIn[provider] ?? 0) +
    (tokensOut / 1_000_000) * (costPerMOut[provider] ?? 0);

  await db.insert(providerUsage).values({
    date: new Date().toISOString().slice(0, 10),
    provider,
    keyHash,
    requests: 1,
    tokensIn,
    tokensOut,
    costUsd,
    updatedAt: new Date(),
  });
}
