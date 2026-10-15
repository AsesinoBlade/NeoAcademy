'use client';

import { AlertTriangle, Box, CheckCircle2, Globe, Monitor, Pause, Play, ShieldCheck, XCircle } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { VerificationPlan } from '@/lib/book/verification-plan';

export interface VerificationDecision {
  approved: boolean;
  allowWeb: boolean;
  allowHostCode: boolean;
  fixtures: Record<string, string>;
}

type Placement = 'sandbox' | 'host' | 'missing';

function Where({ placement }: { placement: Placement | undefined }) {
  if (placement === 'sandbox')
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
        <Box className="size-3" /> Sandbox
      </span>
    );
  if (placement === 'host')
    return (
      <span className="inline-flex items-center gap-1 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-800 dark:bg-sky-900/40 dark:text-sky-300">
        <Monitor className="size-3" /> This PC
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-300">
      <XCircle className="size-3" /> Not installed
    </span>
  );
}

const Cmd = ({ argv }: { argv: string[] }) => (
  <code className="block whitespace-pre-wrap break-all rounded bg-slate-900 px-2 py-1 font-mono text-[11px] text-slate-100">
    {argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}
  </code>
);

export function VerificationPlanPanel({
  plan,
  sandbox,
  placements,
  onDecision,
}: {
  plan: VerificationPlan;
  sandbox: { ready: boolean; reason?: string };
  placements: Record<string, Placement>;
  onDecision: (decision: VerificationDecision | 'pause') => void;
}) {
  const hasWeb = plan.docSources.some((d) => d.kind === 'web');
  const [allowWeb, setAllowWeb] = useState(hasWeb);
  const [allowHostCode, setAllowHostCode] = useState(false);
  const [fixtures, setFixtures] = useState<Record<string, string>>({});
  const place = (program?: string) => (program ? placements[program.toLowerCase()] : undefined);
  const hostCodeCommands = [...plan.checks, ...plan.docSources.filter((d) => d.kind === 'tool-help')].filter(
    (c) => c.executesCode && place('command' in c && c.command ? c.command[0] : undefined) === 'host',
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-50/95 backdrop-blur-sm dark:bg-slate-950/95">
      <div className="border-b bg-white/80 dark:bg-slate-900/80">
        <div className="mx-auto w-full max-w-3xl px-4 py-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <ShieldCheck className="size-5" /> Approve how this book will be verified
          </h2>
          <p className="text-sm text-muted-foreground">
            Nothing below runs until you approve it. Book code only runs in the sandbox (no network, isolated); text from
            the web is used for facts only, never as code.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 text-sm">
          <div
            className={cn(
              'flex items-start gap-2 rounded-lg border p-3',
              sandbox.ready ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/20' : 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20',
            )}
          >
            {sandbox.ready ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" /> : <AlertTriangle className="mt-0.5 size-4 text-amber-600" />}
            <div>
              <p className="font-medium">{sandbox.ready ? 'Sandbox ready' : 'Sandbox not available'}</p>
              <p className="text-muted-foreground">
                {sandbox.ready
                  ? 'Compiling, building, testing and running code happens in an isolated Docker container without network access.'
                  : `${sandbox.reason} Without it, nothing that runs book code will run (unless you allow it on this PC below).`}
              </p>
              {!sandbox.ready && (
                <code className="mt-1 block rounded bg-slate-900 px-2 py-1 font-mono text-[11px] text-slate-100 select-all">
                  docker build -t neoacademy-sandbox:1 docker/sandbox
                </code>
              )}
            </div>
          </div>

          {(plan.subjects.length > 0 || plan.versions.length > 0) && (
            <div className="rounded-lg border bg-white p-3 dark:bg-slate-900">
              <p className="font-medium">Subjects</p>
              <p className="text-muted-foreground">{plan.subjects.join(', ')}</p>
              {plan.versions.length > 0 && (
                <p className="mt-1">
                  <span className="font-medium">Target versions:</span> {plan.versions.map((v) => `${v.tool} ${v.version}`).join(' · ')}
                </p>
              )}
            </div>
          )}

          {plan.tools.length > 0 && (
            <div className="rounded-lg border bg-white p-3 dark:bg-slate-900">
              <p className="mb-2 font-medium">Tools</p>
              <ul className="space-y-1.5">
                {plan.tools.map((t) => (
                  <li key={t.name + (t.executable ?? '')} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    {t.executable && <Where placement={place(t.executable)} />}
                    <span className="text-xs text-muted-foreground">{t.purpose}</span>
                    {t.executable && place(t.executable) === 'missing' && t.installHint && (
                      <span className="w-full pl-1 text-xs">Install: {t.installHint}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.checks.length > 0 && (
            <div className="rounded-lg border bg-white p-3 dark:bg-slate-900">
              <p className="mb-2 font-medium">Checks for the book&apos;s code samples</p>
              <ul className="space-y-2">
                {plan.checks.map((c) => (
                  <li key={c.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{c.label}</span>
                      <span className="text-xs text-muted-foreground">({c.languages.join(', ')} samples)</span>
                      <Where placement={place(c.command[0])} />
                      {c.executesCode && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          runs book code
                        </span>
                      )}
                    </div>
                    <Cmd argv={c.command} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.docSources.length > 0 && (
            <div className="rounded-lg border bg-white p-3 dark:bg-slate-900">
              <p className="mb-2 font-medium">Reference documentation to assemble</p>
              <ul className="space-y-2">
                {plan.docSources.map((d) => (
                  <li key={d.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {d.kind === 'web' ? <Globe className="size-3.5" /> : null}
                      <span className="font-medium">{d.tool}</span>
                      <span className="text-xs text-muted-foreground">{d.description}</span>
                      {d.kind === 'tool-help' && <Where placement={place(d.command?.[0])} />}
                    </div>
                    {d.kind === 'tool-help' && d.command && <Cmd argv={d.command} />}
                    {d.kind === 'local-path' && <code className="text-[11px]">{d.path}</code>}
                    {d.kind === 'web' && <code className="break-all text-[11px]">{d.url}</code>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.fixtures.length > 0 && (
            <div className="rounded-lg border bg-white p-3 dark:bg-slate-900">
              <p className="mb-2 font-medium">Inputs for the checks (optional)</p>
              {plan.fixtures.map((f) => (
                <label key={f.name} className="mb-2 block">
                  <span className="text-xs text-muted-foreground">{f.description}</span>
                  <input
                    className="mt-1 w-full rounded border bg-background px-2 py-1 font-mono text-xs"
                    placeholder="C:\path\to\file"
                    value={fixtures[f.name] ?? ''}
                    onChange={(e) => setFixtures({ ...fixtures, [f.name]: e.target.value })}
                  />
                </label>
              ))}
            </div>
          )}

          <div className="space-y-2 rounded-lg border bg-white p-3 dark:bg-slate-900">
            {hasWeb && (
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={allowWeb} onChange={(e) => setAllowWeb(e.target.checked)} />
                <span>
                  Fetch the official documentation pages listed above
                  <span className="block text-xs text-muted-foreground">Saved as plain text only (no scripts), used to confirm facts.</span>
                </span>
              </label>
            )}
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={allowHostCode} onChange={(e) => setAllowHostCode(e.target.checked)} />
              <span>
                Allow running the book&apos;s code on this PC when the sandbox can&apos;t (Windows-only tools)
                <span className="block text-xs text-muted-foreground">
                  Off is safer: Windows-only tools then only show help or compile/syntax-check
                  {hostCodeCommands.length ? `; ${hostCodeCommands.length} command(s) above would need this` : ''}. Code that uses the network,
                  starts processes, edits the registry or deletes files is never run either way.
                </span>
              </span>
            </label>
          </div>
        </div>
      </div>

      <div className="border-t bg-white/90 dark:bg-slate-900/90">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={() => onDecision('pause')}>
            <Pause className="mr-1.5 size-3.5" /> Pause and decide later
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onDecision({ approved: false, allowWeb: false, allowHostCode: false, fixtures: {} })}>
              Continue without running anything
            </Button>
            <Button onClick={() => onDecision({ approved: true, allowWeb, allowHostCode, fixtures })}>
              <Play className="mr-1.5 size-4" /> Approve and continue
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
