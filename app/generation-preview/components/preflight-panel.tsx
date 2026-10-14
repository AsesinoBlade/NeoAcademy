'use client';

import { AlertTriangle, CheckCircle2, Loader2, Pause, Play, RefreshCw, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PreflightCheck, PreflightResult } from '@/lib/book/preflight';

export type PreflightDecision = 'recheck' | 'continue' | 'pause';

/** Render a fix step: anything that looks like a command is shown as code. */
function FixStep({ text }: { text: string }) {
  const command = text.match(/^(.*?:\s*)?((?:winget|pnpm|npm|docker|sudo|brew|xcode-select|choco|pacman|rustup)\b[^\n]*|[A-Z_]+=\S[^\n]*)$/);
  if (!command) return <span>{text}</span>;
  return (
    <span>
      {command[1]}
      <code className="mt-1 block whitespace-pre-wrap break-all rounded bg-slate-900 px-2 py-1 font-mono text-[12px] text-slate-100 select-all">
        {command[2]}
      </code>
    </span>
  );
}

function CheckRow({ check }: { check: PreflightCheck }) {
  const Icon = check.status === 'ok' ? CheckCircle2 : check.blocking ? XCircle : AlertTriangle;
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        check.status === 'ok'
          ? 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20'
          : check.blocking
            ? 'border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20'
            : 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20',
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            'mt-0.5 size-4 shrink-0',
            check.status === 'ok' ? 'text-emerald-600' : check.blocking ? 'text-red-600' : 'text-amber-600',
          )}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{check.label}</span>
            {check.status !== 'ok' && (
              <span className="text-xs text-muted-foreground">
                {check.blocking ? 'required' : 'needed for full quality'}
              </span>
            )}
          </div>
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{check.detail}</p>
          {check.status !== 'ok' && check.fix && (
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">
              {check.fix.map((step, i) => (
                <li key={i}>
                  <FixStep text={step} />
                </li>
              ))}
            </ol>
          )}
          {check.status !== 'ok' && check.ifIgnored && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">If you continue anyway:</span> {check.ifIgnored}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function PreflightPanel({
  result,
  checking,
  onDecision,
}: {
  result: PreflightResult;
  checking: boolean;
  onDecision: (decision: PreflightDecision) => void;
}) {
  const problems = result.checks.filter((c) => c.status !== 'ok');
  const passed = result.checks.filter((c) => c.status === 'ok');

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-50/95 backdrop-blur-sm dark:bg-slate-950/95">
      <div className="border-b bg-white/80 dark:bg-slate-900/80">
        <div className="mx-auto w-full max-w-3xl px-4 py-4">
          <h2 className="text-lg font-semibold">
            {result.blocking ? 'Generation paused: something required is missing' : 'Generation paused: some tools are missing'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {result.stage === 'start'
              ? 'Checked before writing starts, so you are not told hours later.'
              : "Checked against the book's project plan before any chapter is written."}{' '}
            Fix the items below, then click <span className="font-medium">Check again</span> — no restart is needed for
            installed tools or .env.local changes.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-4">
          {problems.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
          {passed.length > 0 && (
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">{passed.length} check(s) passed</summary>
              <div className="mt-2 space-y-2">
                {passed.map((check) => (
                  <CheckRow key={check.id} check={check} />
                ))}
              </div>
            </details>
          )}
        </div>
      </div>

      <div className="border-t bg-white/90 dark:bg-slate-900/90">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={() => onDecision('pause')} disabled={checking}>
            <Pause className="mr-1.5 size-3.5" />
            Pause and fix later
          </Button>
          <div className="flex gap-2">
            {!result.blocking && (
              <Button variant="outline" onClick={() => onDecision('continue')} disabled={checking}>
                <Play className="mr-1.5 size-4" />
                Continue without these
              </Button>
            )}
            <Button onClick={() => onDecision('recheck')} disabled={checking}>
              {checking ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <RefreshCw className="mr-1.5 size-4" />}
              Check again
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
