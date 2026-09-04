import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { user } from '@/lib/db/schema';
import {
  setGeminiConfig,
  setOllamaConfig,
  setTTSConfig,
  setASRConfig,
  DEFAULTS,
} from '@/lib/db/config';

export async function POST(req: NextRequest) {
  try {
    // Only allow after the admin account has been created.
    const existing = await db.select({ id: user.id }).from(user).limit(1);
    if (existing.length === 0) {
      return NextResponse.json({ error: 'Create admin account first' }, { status: 403 });
    }

    const { geminiKeys, ollamaUrl, ttsUrl, asrUrl } = await req.json();

    // Gemini is optional in fully-local mode.
    // Explicitly disable it when no keys were supplied.
    const geminiDefault = DEFAULTS.gemini();
    await setGeminiConfig({
      ...geminiDefault,
      freeKeys: geminiKeys ?? [],
      paidKey: '',
      enabled: Array.isArray(geminiKeys) && geminiKeys.length > 0,
    });

    // Use the Ollama model configured through .env.local rather than
    // hard-coding qwen3.5:latest.
    const ollamaDefault = DEFAULTS.ollama();
    await setOllamaConfig({
      ...ollamaDefault,
      baseUrl: ollamaUrl,
    });

    await setTTSConfig({
      baseUrl: ttsUrl,
      apiKey: 'kokoro',
      defaultVoice: 'af_bella',
    });

    await setASRConfig({
      baseUrl: asrUrl,
      apiKey: 'whisper',
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[setup/save-providers]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
