/**
 * Director Prompt Builder
 *
 * Constructs the system prompt for the director agent that decides
 * which agent should respond next in a multi-agent conversation.
 */

import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('DirectorPrompt');

/**
 * A single whiteboard action performed by an agent, recorded in the ledger.
 */
export interface WhiteboardActionRecord {
  actionName:
    | 'wb_draw_text'
    | 'wb_draw_shape'
    | 'wb_draw_chart'
    | 'wb_draw_latex'
    | 'wb_draw_table'
    | 'wb_draw_line'
    | 'wb_clear'
    | 'wb_delete'
    | 'wb_open'
    | 'wb_close';
  agentId: string;
  agentName: string;
  params: Record<string, unknown>;
}

/**
 * Summary of an agent's turn in the current round
 */
export interface AgentTurnSummary {
  agentId: string;
  agentName: string;
  contentPreview: string;
  actionCount: number;
  whiteboardActions: WhiteboardActionRecord[];
}

/**
 * Build the system prompt for the director agent
 *
 * @param agents - Available agent configurations
 * @param conversationSummary - Condensed summary of recent conversation
 * @param agentResponses - Agents that have already responded this round
 * @param turnCount - Current turn number in this round
 */
export function buildDirectorPrompt(
  agents: AgentConfig[],
  conversationSummary: string,
  agentResponses: AgentTurnSummary[],
  turnCount: number,
  discussionContext?: { topic: string; prompt?: string } | null,
  triggerAgentId?: string | null,
  whiteboardLedger?: WhiteboardActionRecord[],
  userProfile?: { nickname?: string; bio?: string },
  whiteboardOpen?: boolean,
): string {
  const agentList = agents
    .map((a) => `- id: "${a.id}", name: "${a.name}", role: ${a.role}, priority: ${a.priority}`)
    .join('\n');

  const respondedList =
    agentResponses.length > 0
      ? agentResponses
          .map((r) => {
            const wbSummary = summarizeAgentWhiteboardActions(r.whiteboardActions);
            const wbPart = wbSummary ? ` | Whiteboard: ${wbSummary}` : '';
            return `- ${r.agentName} (${r.agentId}): "${r.contentPreview}" [${r.actionCount} actions${wbPart}]`;
          })
          .join('\n')
      : 'None yet.';

  log.info(`[DirectorPrompt] Responded list:\n${respondedList}`);
  console.log(`[DirectorPrompt] Responded list:\n${respondedList}`);

  const isDiscussion = !!discussionContext;

  const discussionSection = isDiscussion
    ? `\n# Discussion Mode
Topic: "${discussionContext!.topic}"${discussionContext!.prompt ? `\nPrompt: "${discussionContext!.prompt}"` : ''}${triggerAgentId ? `\nInitiator: "${triggerAgentId}"` : ''}
This is a student-initiated discussion, not a Q&A session.\n`
    : '';

  const rule1 = isDiscussion
    ? `1. The discussion initiator${triggerAgentId ? ` ("${triggerAgentId}")` : ''} should speak first to kick off the topic. Then the teacher responds to guide the discussion. After that, other students may add their perspectives.`
    : "1. The teacher (role: teacher, highest priority) should usually speak first to address the user's question or topic.";

  // Build whiteboard state section for director awareness
  const whiteboardSection = buildWhiteboardStateForDirector(whiteboardLedger);

  // Build student profile section for director awareness
  const studentProfileSection =
    userProfile?.nickname || userProfile?.bio
      ? `
# Student Profile
Student name: ${userProfile.nickname || 'Unknown'}
${userProfile.bio ? `Background: ${userProfile.bio}` : ''}
`
      : '';

  return `You are the Director of a multi-agent classroom. Your job is to decide which agent should speak next based on the conversation context.

# Available Agents
${agentList}

# Agents Who Already Spoke This Round
${respondedList}

# Conversation Context
${conversationSummary}
${discussionSection}${whiteboardSection}${studentProfileSection}
# Rules
${rule1}
2. PRIMARY TASK COMPLETION (CRITICAL): In normal Q&A, the user's original request takes priority over follow-up discussion. Before dispatching a student, assistant, or the user, determine whether the teacher has fully answered every material part of the user's original request.
3. If the original request is not yet fully answered, normally dispatch the teacher again so they can continue the unfinished explanation. This is allowed even if the teacher already spoke in the current round.

4. TEACHER QUESTION EXCEPTION: If the teacher's most recent response explicitly asks the class a question, invites a student to answer, asks what they think, checks their understanding, or otherwise clearly opens a brief participation turn, dispatch ONE appropriate student or assistant next even if the original user request is not yet complete. This is not a side discussion — it is part of the teacher-led lesson.

5. After that student or assistant responds, if the original user request is still unfinished, dispatch the teacher again so they can react briefly to the response and continue the requested teaching task. Do not allow the participation exchange to derail or replace completion of the user's request.

6. Do NOT allow unrelated student follow-up questions, jokes, side discussions, note-taking, or alternative perspectives while the original request remains unfinished. Only the explicit teacher-question exception above may temporarily interrupt task completion.
7. FOLLOW-UP PARTICIPATION: Once the original request is complete, if multiple agents are available and no non-teacher agent has yet participated in this response cycle, dispatch ONE appropriate student or assistant for a brief useful follow-up before ending the conversation. This is especially important when the teacher explicitly invites questions, asks whether the material is clear, or opens the floor for discussion.
8. Output END only after the original request is complete AND either:
   - at least one appropriate non-teacher follow-up has occurred, or
   - the user explicitly requested a teacher-only response or no discussion.
9. Current turn: ${turnCount + 1}. Consider conversation length, but NEVER shorten or interrupt an unfinished answer to the user's original request merely to add role diversity.
10. Prefer brevity after the original request has been completed. Don't force every agent to speak.
11. You can output {"next_agent":"USER"} to cue the user to speak, but do not do this while the teacher still owes part of the original answer unless user input is genuinely required to continue.
12. Consider whiteboard state when routing: if the whiteboard is already crowded, the teacher may continue by clearing or organizing it as needed. Do not route away from an unfinished teaching task merely because the whiteboard is crowded.
13. Whiteboard is currently ${whiteboardOpen ? 'OPEN (slide canvas is hidden — spotlight/laser will not work)' : 'CLOSED (slide canvas is visible)'}. When the whiteboard is open, do not expect spotlight or laser actions to have visible effect.

# Routing Quality (CRITICAL)
- TASK COMPLETION OVERRIDES ROLE DIVERSITY: While the user's original request is unfinished, the teacher may be dispatched for consecutive turns. Do NOT insert a student or assistant merely for variety.
- TEACHER-LED PARTICIPATION: An explicit question from the teacher to the class temporarily overrides TASK COMPLETION routing for exactly one student/assistant response. After that response, return to the teacher if the user's original task is still unfinished.
- POST-TASK PARTICIPATION: After the teacher completes the user's original request, allow at least one student or assistant to respond before END when multiple agents are available. If the teacher explicitly asks for questions or discussion, do not END immediately.
- ROLE DIVERSITY: After the user's original request has been fully answered, avoid dispatching two agents of the same role consecutively when another role would add useful value.
- CONTENT DEDUP: Do not repeat material already explained thoroughly. However, continuing with an unanswered part of a multi-part request is NOT repetition. For example, after explaining item 1 of a requested three-item explanation, the teacher should continue with items 2 and 3.
- DISCUSSION PROGRESSION: Normally complete the user's requested teaching task before broader follow-up discussion. The TEACHER QUESTION EXCEPTION above may create a brief teacher → student → teacher exchange during the task, but it must not derail completion of the user's request.
- POST-TASK DISCUSSION PACING: After the user's original request is complete, allow a natural short discussion among the agents when it adds value.
- Do not keep the discussion alive solely for participation. If the last 2-3 turns are mostly agreement, restatement, or light elaboration with no new question or misconception, output END.
- If a student asks a genuine new question or introduces a useful misconception, allow the teacher to answer it before ending.
- GREETING RULE: If any agent has already greeted the students, no subsequent agent should greet again. Check the previews for greetings.

# Output Format
You MUST output ONLY a JSON object, nothing else:
{"next_agent":"<agent_id>"}
or
{"next_agent":"USER"}
or
{"next_agent":"END"}`;
}

/**
 * Summarize a single agent's whiteboard actions into a compact description.
 */
function summarizeAgentWhiteboardActions(actions: WhiteboardActionRecord[]): string {
  if (!actions || actions.length === 0) return '';

  const parts: string[] = [];
  for (const a of actions) {
    switch (a.actionName) {
      case 'wb_draw_text': {
        const content = String(a.params.content || '').slice(0, 30);
        parts.push(`drew text "${content}${content.length >= 30 ? '...' : ''}"`);
        break;
      }
      case 'wb_draw_shape':
        parts.push(`drew shape(${a.params.type || 'rectangle'})`);
        break;
      case 'wb_draw_chart': {
        const labels = Array.isArray(a.params.labels)
          ? a.params.labels
          : (a.params.data as Record<string, unknown>)?.labels;
        const chartType = a.params.chartType || a.params.type || 'bar';
        parts.push(
          `drew chart(${chartType}${labels ? `, labels: [${(labels as string[]).slice(0, 4).join(',')}]` : ''})`,
        );
        break;
      }
      case 'wb_draw_latex': {
        const latex = String(a.params.latex || '').slice(0, 30);
        parts.push(`drew formula "${latex}${latex.length >= 30 ? '...' : ''}"`);
        break;
      }
      case 'wb_draw_table': {
        const data = a.params.data as unknown[][] | undefined;
        const rows = data?.length || 0;
        const cols = (data?.[0] as unknown[])?.length || 0;
        parts.push(`drew table(${rows}×${cols})`);
        break;
      }
      case 'wb_draw_line': {
        const pts = a.params.points as string[] | undefined;
        const hasArrow = pts?.includes('arrow') ? ' arrow' : '';
        parts.push(`drew${hasArrow} line`);
        break;
      }
      case 'wb_clear':
        parts.push('CLEARED whiteboard');
        break;
      case 'wb_delete':
        parts.push(`deleted element "${a.params.elementId}"`);
        break;
      case 'wb_open':
      case 'wb_close':
        // Skip open/close from summary — they're structural, not content
        break;
    }
  }
  return parts.join(', ');
}

/**
 * Replay the whiteboard ledger to compute current element count and contributors.
 */
export function summarizeWhiteboardForDirector(ledger: WhiteboardActionRecord[]): {
  elementCount: number;
  contributors: string[];
} {
  let elementCount = 0;
  const contributorSet = new Set<string>();

  for (const record of ledger) {
    if (record.actionName === 'wb_clear') {
      elementCount = 0;
      // Don't reset contributors — they still participated
    } else if (record.actionName === 'wb_delete') {
      elementCount = Math.max(0, elementCount - 1);
    } else if (record.actionName.startsWith('wb_draw_')) {
      elementCount++;
      contributorSet.add(record.agentName);
    }
  }

  return {
    elementCount,
    contributors: Array.from(contributorSet),
  };
}

/**
 * Build the whiteboard state section for the director prompt.
 * Returns empty string if there are no whiteboard actions.
 */
function buildWhiteboardStateForDirector(ledger?: WhiteboardActionRecord[]): string {
  if (!ledger || ledger.length === 0) return '';

  const { elementCount, contributors } = summarizeWhiteboardForDirector(ledger);
  const crowdedWarning =
    elementCount > 5
      ? '\n⚠ The whiteboard is getting crowded. Consider routing to an agent that will organize or clear it rather than adding more.'
      : '';

  return `
# Whiteboard State
Elements on whiteboard: ${elementCount}
Contributors: ${contributors.length > 0 ? contributors.join(', ') : 'none'}${crowdedWarning}
`;
}

/**
 * Parse the director's decision from its response
 *
 * @param content - Raw LLM response content
 * @returns Parsed decision with nextAgentId and shouldEnd flag
 */
export function parseDirectorDecision(content: string): {
  nextAgentId: string | null;
  shouldEnd: boolean;
} {
  try {
    // Try to extract JSON from the response
    const jsonMatch = content.match(/\{[\s\S]*?"next_agent"[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const nextAgent = parsed.next_agent;

      if (!nextAgent || nextAgent === 'END') {
        return { nextAgentId: null, shouldEnd: true };
      }

      return { nextAgentId: nextAgent, shouldEnd: false };
    }
  } catch (_e) {
    log.warn('[Director] Failed to parse decision:', content.slice(0, 200));
  }

  // Default: end the round if we can't parse
  return { nextAgentId: null, shouldEnd: true };
}
