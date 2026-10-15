/**
 * The book's verification plan (see lib/book/verification-plan.ts).
 *
 * POST { bookId }                       → create (once) and return the plan
 * POST { bookId, action: 'decide', approved, allowWeb, allowHostCode, fixtures }
 *                                        → record the user's decision
 *
 * Creating a plan runs nothing: tools are only LOOKED UP on this PC.
 */
import { type NextRequest } from 'next/server';
import { existsSync } from 'node:fs';
import os from 'node:os';

import { parseJsonResponse } from '@/lib/generation/json-repair';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { generateBookText, tableOfContents } from '@/lib/book/llm';
import { sandboxStatus, inSandboxImage } from '@/lib/book/sandbox';
import { parseSectionSpec, readBook, writeBook } from '@/lib/book/storage';
import { discoverTools, sanitisePlan, type VerificationPlan } from '@/lib/book/verification-plan';

const log = createLogger('Book Verification Plan API');

export const runtime = 'nodejs';
export const maxDuration = 600;

/** Where each program would run: the sandbox, this PC, or nowhere (not installed). */
function placements(plan: VerificationPlan, sandboxReady: boolean): Record<string, 'sandbox' | 'host' | 'missing'> {
  const out: Record<string, 'sandbox' | 'host' | 'missing'> = {};
  const programs = new Set<string>();
  for (const t of plan.tools) if (t.executable) programs.add(t.executable.toLowerCase());
  for (const c of plan.checks) programs.add(c.command[0].toLowerCase());
  for (const d of plan.docSources) if (d.command?.[0]) programs.add(d.command[0].toLowerCase());
  for (const p of programs) {
    const tool = plan.tools.find((t) => t.executable?.toLowerCase() === p);
    out[p] = sandboxReady && inSandboxImage(p) ? 'sandbox' : tool?.resolvedPath ? 'host' : 'missing';
  }
  return out;
}

function platformLine(): string {
  if (process.platform === 'win32') return `Windows ${os.release().startsWith('10.0.2') ? '11' : '10/11'} (${process.arch}). Book code is compiled and run in a Linux Docker sandbox; Windows-only tools run on the PC itself for help output and compile-only checks.`;
  return `${process.platform} (${process.arch})`;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      bookId: string;
      action?: 'create' | 'decide';
      force?: boolean;
      approved?: boolean;
      allowWeb?: boolean;
      allowHostCode?: boolean;
      fixtures?: Record<string, string>;
    };
    const book = await readBook(body.bookId);
    if (!book) return apiError('INVALID_REQUEST', 404, 'Book not found');
    const sandbox = await sandboxStatus();

    if (body.action === 'decide') {
      const plan = book.verificationPlan;
      if (!plan) return apiError('INVALID_REQUEST', 409, 'No verification plan to decide on');
      for (const f of plan.fixtures) {
        const p = body.fixtures?.[f.name]?.trim().replace(/^"|"$/g, '');
        f.path = p && existsSync(p) ? p : undefined;
      }
      plan.decision = {
        approved: !!body.approved,
        at: new Date().toISOString(),
        allowWeb: !!body.allowWeb,
        allowHostCode: !!body.allowHostCode,
      };
      await writeBook({ ...book, verificationPlan: plan });
      log.info(
        `Verification plan ${plan.decision.approved ? 'approved' : 'declined'} for "${book.title}"` +
          ` (web docs: ${plan.decision.allowWeb ? 'yes' : 'no'}, book code on this PC: ${plan.decision.allowHostCode ? 'allowed' : 'not allowed'})`,
      );
      return apiSuccess({ plan, sandbox, placements: placements(plan, sandbox.ready) });
    }

    if (book.verificationPlan && !body.force) {
      return apiSuccess({ plan: book.verificationPlan, sandbox, placements: placements(book.verificationPlan, sandbox.ready) });
    }

    const prompts = buildPrompt(PROMPT_IDS.BOOK_VERIFICATION_PLAN, {
      requirement: book.requirement,
      bookTitle: book.title,
      tableOfContents: tableOfContents(book.outline, (p) => parseSectionSpec(p).title),
      platform: platformLine(),
    });
    if (!prompts) return apiError('INTERNAL_ERROR', 500, 'Verification plan prompt not found');
    const raw = await generateBookText(req, prompts.system, prompts.user, 5000, 'book-verification-plan');
    const sanitised = sanitisePlan(parseJsonResponse<unknown>(raw));
    await discoverTools(sanitised);
    const plan: VerificationPlan = { createdAt: new Date().toISOString(), ...sanitised };
    await writeBook({ ...book, verificationPlan: plan });
    log.info(
      `Planned verification for "${book.title}": ${plan.subjects.join(', ') || 'no subjects'} — ` +
        `${plan.checks.length} check(s), ${plan.docSources.length} doc source(s), ` +
        `tools: ${plan.tools.map((t) => `${t.name}${t.executable ? ` (${inSandboxImage(t.executable) ? 'sandbox' : t.resolvedPath ? 'this PC' : 'missing'})` : ''}`).join(', ')}`,
    );
    return apiSuccess({ plan, sandbox, placements: placements(plan, sandbox.ready) });
  } catch (error) {
    log.error('Verification plan failed:', error);
    return apiError('GENERATION_FAILED', 500, error instanceof Error ? error.message : String(error));
  }
}
