/**
 * Agent Profiles Generation API
 *
 * Generates agent profiles (teacher, assistant, student) for a course stage
 * based on stage info and scene outlines.
 */

import { NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';

const log = createLogger('Agent Profiles API');

export const maxDuration = 120;

const COLOR_PALETTE = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#8b5cf6',
  '#f97316',
  '#14b8a6',
  '#e11d48',
  '#6366f1',
  '#84cc16',
  '#a855f7',
];

interface RequestBody {
  stageInfo: { name: string; description?: string };
  sceneOutlines?: { title: string; description?: string }[];
  language: string;
  availableAvatars: string[];
}

interface AgentProfilesPayload {
  agents: Array<{
    name: string;
    role: string;
    persona: string;
    avatar: string;
    color: string;
    priority: number;
    voiceGender?: 'female' | 'male' | 'neutral';
    voiceStyle?: 'warm' | 'bright' | 'calm' | 'energetic' | 'deep' | 'youthful';
  }>;
}

type VoiceGender = 'female' | 'male' | 'neutral';
type VoiceStyle = 'warm' | 'bright' | 'calm' | 'energetic' | 'deep' | 'youthful';

function selectKokoroVoice(
  language: string,
  gender: VoiceGender,
  style: VoiceStyle,
  index: number,
): string {
  const lang = language.toLowerCase();

  // Language-specific Kokoro voices where available.
  if (lang.startsWith('zh')) {
    const female = ['zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi'];
    const male = ['zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang'];
    const pool = gender === 'male' ? male : gender === 'female' ? female : [...female, ...male];
    return pool[index % pool.length];
  }

  if (lang.startsWith('ja')) {
    const female = ['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro'];
    const male = ['jm_kumo'];
    const pool = gender === 'male' ? male : gender === 'female' ? female : [...female, ...male];
    return pool[index % pool.length];
  }

  if (lang.startsWith('it')) {
    return gender === 'male' ? 'im_nicola' : 'if_sara';
  }

  if (lang.startsWith('fr')) {
    return 'ff_siwis';
  }

  if (lang.startsWith('en-gb')) {
    const female = ['bf_emma', 'bf_alice', 'bf_isabella', 'bf_lily'];
    const male = ['bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis'];
    const pool = gender === 'male' ? male : gender === 'female' ? female : [...female, ...male];
    return pool[index % pool.length];
  }

  // Default English/US voices. Curated by broad vocal character.
  const femalePools: Record<VoiceStyle, string[]> = {
    warm: ['af_bella', 'af_sarah', 'af_nicole'],
    calm: ['af_sarah', 'af_nicole', 'af_river'],
    bright: ['af_sky', 'af_nova', 'af_aoede'],
    energetic: ['af_heart', 'af_jessica', 'af_nova'],
    deep: ['af_kore', 'af_river', 'af_nicole'],
    youthful: ['af_sky', 'af_nova', 'af_aoede'],
  };

  const malePools: Record<VoiceStyle, string[]> = {
    warm: ['am_liam', 'am_michael', 'am_eric'],
    calm: ['am_michael', 'am_liam', 'am_onyx'],
    bright: ['am_eric', 'am_puck', 'am_echo'],
    energetic: ['am_puck', 'am_fenrir', 'am_eric'],
    deep: ['am_adam', 'am_onyx', 'am_michael'],
    youthful: ['am_puck', 'am_eric', 'am_liam'],
  };

  if (gender === 'female') {
    const pool = femalePools[style];
    return pool[index % pool.length];
  }

  if (gender === 'male') {
    const pool = malePools[style];
    return pool[index % pool.length];
  }

  const pool = [...femalePools[style], ...malePools[style]];
  return pool[index % pool.length];
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  // Remove markdown code fences (```json ... ``` or ``` ... ```)
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as RequestBody;
    const { stageInfo, sceneOutlines, language, availableAvatars } = body;

    // ── Validate required fields ──
    if (!stageInfo?.name) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageInfo.name is required');
    }
    if (!language) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'language is required');
    }
    if (!availableAvatars || availableAvatars.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'availableAvatars is required and must not be empty',
      );
    }

    // ── Model resolution from request headers ──
    const { model: languageModel, modelString } = resolveModelFromHeaders(req);

    // ── Build prompt ──
    const sceneSummary = sceneOutlines?.length
      ? sceneOutlines
          .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''}`)
          .join('\n')
      : null;

    const systemPrompt = `You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Decide the appropriate number of agents (typically 3-5) based on the course content and complexity. Return ONLY valid JSON, no markdown or explanation.`;

    const userPrompt = `Generate agent profiles for the following course:

Course name: ${stageInfo.name}
${stageInfo.description ? `Course description: ${stageInfo.description}` : ''}
${sceneSummary ? `\nScene outlines:\n${sceneSummary}\n` : ''}
Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Priority values: teacher=10 (highest), assistant=7, student=4-6
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Each agent also needs a vocal profile that matches the character:
  - voiceGender: "female", "male", or "neutral"
  - voiceStyle: "warm", "bright", "calm", "energetic", "deep", or "youthful"
- Choose voiceGender from the character you create. For example, a clearly female teacher such as "Ms. Stella" must use "female".
- Choose voiceStyle to match the character's personality and role.
- Names and personas must be in language: ${language}
- Each agent must be assigned one avatar from this list: ${JSON.stringify(availableAvatars)}
  - Try to use different avatars for each agent
- Each agent must be assigned one color from this list: ${JSON.stringify(COLOR_PALETTE)}
  - Each agent must have a different color

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)",
      "avatar": "string (from available list)",
      "color": "string (hex color from palette)",
      "priority": number (10 for teacher, 7 for assistant, 4-6 for student),
      "voiceGender": "female" | "male" | "neutral",
      "voiceStyle": "warm" | "bright" | "calm" | "energetic" | "deep" | "youthful"
    }
  ]
}`;

    log.info(`Generating agent profiles for "${stageInfo.name}" [model=${modelString}]`);

    const result = await callLLM(
      {
        model: languageModel,
        system: systemPrompt,
        prompt: userPrompt,
      },
      'agent-profiles',
      {
        retries: 1,
        validate: (text) => {
          try {
            const candidate = JSON.parse(stripCodeFences(text)) as AgentProfilesPayload;

            if (!Array.isArray(candidate.agents) || candidate.agents.length < 2) {
              return false;
            }

            const teacherCount = candidate.agents.filter(
              (agent) => agent.role === 'teacher',
            ).length;

            return teacherCount === 1;
          } catch {
            return false;
          }
        },
      },
    );

    // ── Parse LLM response ──
    const rawText = stripCodeFences(result.text);
    let parsed: AgentProfilesPayload;

    try {
      parsed = JSON.parse(rawText);
    } catch {
      log.error('Failed to parse LLM response as JSON:', rawText.substring(0, 500));
      return apiError('PARSE_FAILED', 500, 'Failed to parse agent profiles from LLM response');
    }

    // ── Validate parsed structure ──
    if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
      log.error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
      return apiError(
        'GENERATION_FAILED',
        500,
        `Expected at least 2 agents but LLM returned ${parsed.agents?.length ?? 0}`,
      );
    }

    const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
    if (teacherCount !== 1) {
      log.error(`Expected exactly 1 teacher, got ${teacherCount}`);
      return apiError(
        'GENERATION_FAILED',
        500,
        `Expected exactly 1 teacher but LLM returned ${teacherCount}`,
      );
    }

    // ── Build output with IDs ──
    const usedVoiceIds = new Set<string>();

    const agents = parsed.agents.map((agent, index) => {
      const voiceGender: VoiceGender =
        agent.voiceGender === 'female' ||
        agent.voiceGender === 'male' ||
        agent.voiceGender === 'neutral'
          ? agent.voiceGender
          : 'neutral';

      const voiceStyle: VoiceStyle =
        agent.voiceStyle === 'warm' ||
        agent.voiceStyle === 'bright' ||
        agent.voiceStyle === 'calm' ||
        agent.voiceStyle === 'energetic' ||
        agent.voiceStyle === 'deep' ||
        agent.voiceStyle === 'youthful'
          ? agent.voiceStyle
          : agent.role === 'teacher'
            ? 'warm'
            : 'bright';

      // Prefer a voice appropriate to this character, but never reuse a
      // voice already assigned to another character in the same classroom.
      let voiceId = selectKokoroVoice(language, voiceGender, voiceStyle, index);

      for (let offset = 1; usedVoiceIds.has(voiceId) && offset < 12; offset++) {
        voiceId = selectKokoroVoice(language, voiceGender, voiceStyle, index + offset);
      }

      // If that style's pool was exhausted, try other compatible styles
      // while preserving the character's gender.
      if (usedVoiceIds.has(voiceId)) {
        const fallbackStyles: VoiceStyle[] = [
          'warm',
          'calm',
          'bright',
          'energetic',
          'deep',
          'youthful',
        ];

        outer: for (const fallbackStyle of fallbackStyles) {
          for (let offset = 0; offset < 12; offset++) {
            const candidate = selectKokoroVoice(
              language,
              voiceGender,
              fallbackStyle,
              index + offset,
            );

            if (!usedVoiceIds.has(candidate)) {
              voiceId = candidate;
              break outer;
            }
          }
        }
      }

      usedVoiceIds.add(voiceId);

      return {
        id: `gen-${nanoid(8)}`,
        name: agent.name,
        role: agent.role,
        persona: agent.persona,
        avatar: agent.avatar || availableAvatars[index % availableAvatars.length],
        color: agent.color || COLOR_PALETTE[index % COLOR_PALETTE.length],
        priority:
          agent.priority ?? (agent.role === 'teacher' ? 10 : agent.role === 'assistant' ? 7 : 5),
        voiceGender,
        voiceStyle,
        voiceId,
      };
    });

    log.info(`Successfully generated ${agents.length} agent profiles for "${stageInfo.name}"`);

    return apiSuccess({ agents });
  } catch (error) {
    log.error('Agent profiles generation error:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
