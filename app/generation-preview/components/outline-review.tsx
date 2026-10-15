'use client';

import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Pause,
  Play,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { SceneOutline } from '@/lib/types/generation';
import type { PremiseFinding } from '@/lib/book/principles';

const VERDICT_STYLES: Record<PremiseFinding['verdict'], string> = {
  false: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  unsupported: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  contested: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  supported: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
};

/** The premise check: what the request assumes and how the book treats it. */
function PremiseSummary({ premises }: { premises: PremiseFinding[] }) {
  const flagged = premises.filter((p) => p.verdict !== 'supported');
  const supported = premises.filter((p) => p.verdict === 'supported');
  const Row = ({ p }: { p: PremiseFinding }) => (
    <li className="space-y-1">
      <div className="flex items-start gap-2">
        <span className={cn('mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', VERDICT_STYLES[p.verdict])}>
          {p.verdict}
        </span>
        <span className="font-medium">{p.premise}</span>
      </div>
      <p className="pl-1 text-muted-foreground">{p.explanation}</p>
      <p className="pl-1">
        <span className="font-medium">The book will:</span> {p.treatment}
      </p>
    </li>
  );
  return (
    <div className="rounded-xl border bg-white p-4 text-sm shadow-sm dark:bg-slate-900">
      <h3 className="mb-1 font-semibold">Premise check of your request</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        {flagged.length
          ? `${flagged.length} assumption(s) in your request are not supported by the evidence, so the book explains and corrects them instead of teaching them. Disagree? Say so in the revision notes below.`
          : 'Every assumption in your request is consistent with the evidence.'}
      </p>
      {flagged.length > 0 && <ul className="space-y-3">{flagged.map((p, i) => <Row key={i} p={p} />)}</ul>}
      {supported.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">{supported.length} supported premise(s)</summary>
          <ul className="mt-2 space-y-3 text-sm">{supported.map((p, i) => <Row key={i} p={p} />)}</ul>
        </details>
      )}
    </div>
  );
}

export type OutlineReviewDecision =
  | { action: 'generate'; outlines: SceneOutline[] }
  | { action: 'revise'; outlines: SceneOutline[]; feedback: string };

/**
 * Normalise a reviewed outline: keep `order` in step with the list position
 * after reorders/deletes, and drop blank key-point lines left while editing.
 */
export function renumberOutlines(outlines: SceneOutline[]): SceneOutline[] {
  return outlines.map((outline, index) => ({
    ...outline,
    order: index + 1,
    keyPoints: (outline.keyPoints || []).map((point) => point.trim()).filter(Boolean),
  }));
}

const TYPE_STYLES: Record<string, string> = {
  slide: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  quiz: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  interactive: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  pbl: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  chapter: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
};

const LABELS = {
  class: {
    heading: 'Review the outline',
    unit: 'scenes',
    keyPoints: 'Key points (one per line)',
    notes: 'Teaching notes (rules, worked examples, code, exercise + solution)',
    notesPlaceholder: 'What this scene must actually teach, with concrete examples',
    revisePlaceholder:
      'Notes for a revision, e.g. "Crane is missing — add it after Two-String Kite. ' +
      'Split Swordfish into concept and worked example. End with building the project using make."',
    generate: 'Generate class',
  },
  ebook: {
    heading: 'Review the book outline',
    unit: 'chapters',
    keyPoints: 'Sections (one per line: Title — what it covers)',
    notes: 'Chapter brief (goals, worked examples, planned charts/diagrams/pictures, exercises)',
    notesPlaceholder: 'What this chapter must cover, the examples and figures it should include',
    revisePlaceholder:
      'Notes for a revision, e.g. "Add a chapter on Crane after Two-String Kite. Merge chapters 3 and 4. ' +
      'Every technique chapter needs a fully worked puzzle walkthrough and practice puzzles."',
    generate: 'Write the book',
  },
} as const;

export function OutlineReviewPanel({
  outlines,
  onDraftChange,
  onDecision,
  onPause,
  isPausing,
  mode = 'class',
  premises,
  bookStyle,
}: {
  outlines: SceneOutline[];
  /** Called on every edit so the parent can keep the latest draft. */
  onDraftChange: (draft: SceneOutline[]) => void;
  onDecision: (decision: OutlineReviewDecision) => void;
  onPause: () => void;
  isPausing: boolean;
  mode?: 'class' | 'ebook';
  /** Ebooks: premise check results, shown above the outline. */
  premises?: PremiseFinding[];
  /** Ebooks: book style, for the page estimate. */
  bookStyle?: 'quick' | 'beginner' | 'advanced';
}) {
  const labels = LABELS[mode];
  const [draft, setDraft] = useState<SceneOutline[]>(outlines);
  const [feedback, setFeedback] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // A revised outline arrives as a new `outlines` prop.
  useEffect(() => {
    setDraft(outlines);
    setFeedback('');
    setExpanded(new Set());
  }, [outlines]);

  useEffect(() => {
    onDraftChange(draft);
  }, [draft, onDraftChange]);

  const update = (index: number, patch: Partial<SceneOutline>) =>
    setDraft((current) => current.map((o, i) => (i === index ? { ...o, ...patch } : o)));

  const move = (index: number, delta: -1 | 1) =>
    setDraft((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const remove = (index: number) =>
    setDraft((current) => current.filter((_, i) => i !== index));

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allExpanded = draft.length > 0 && draft.every((o) => expanded.has(o.id));
  const counts = draft.reduce<Record<string, number>>((acc, o) => {
    acc[o.type] = (acc[o.type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-50/95 dark:bg-slate-950/95 backdrop-blur-sm">
      {/* Header */}
      <div className="border-b bg-white/80 dark:bg-slate-900/80">
        <div className="mx-auto w-full max-w-4xl px-4 py-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{labels.heading}</h2>
            <p className="text-sm text-muted-foreground">
              {draft.length} {labels.unit}
              {mode === 'ebook'
                ? ` · ${draft.reduce(
                    (sum, o) => sum + (o.keyPoints || []).filter((p) => p.trim()).length,
                    0,
                  )} sections (~${Math.round(
                    draft.reduce(
                      (sum, o) => sum + (o.keyPoints || []).filter((p) => p.trim()).length,
                      0,
                    ) * (bookStyle === 'quick' ? 2 : bookStyle === 'beginner' ? 3.2 : 4.5),
                  )} pages)`
                : Object.entries(counts).length > 0 &&
                  ` · ${Object.entries(counts)
                    .map(([type, n]) => `${n} ${type}`)
                    .join(', ')}`}
              . Edit anything directly, or write notes below and let the model revise it.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setExpanded(allExpanded ? new Set() : new Set(draft.map((o) => o.id)))
            }
          >
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </Button>
        </div>
      </div>

      {/* Scene list */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-4 space-y-2">
          {premises && premises.length > 0 && <PremiseSummary premises={premises} />}
          {draft.map((outline, index) => {
            const isOpen = expanded.has(outline.id);
            return (
              <div
                key={outline.id}
                className="rounded-xl border bg-white dark:bg-slate-900 shadow-sm"
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => toggle(outline.id)}
                    aria-label={isOpen ? 'Collapse scene' : 'Expand scene'}
                  >
                    {isOpen ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </button>
                  <span className="w-6 text-right text-xs font-bold text-muted-foreground">
                    {index + 1}
                  </span>
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                      TYPE_STYLES[outline.type] ?? 'bg-muted text-muted-foreground',
                    )}
                  >
                    {outline.type}
                  </span>
                  <Input
                    value={outline.title}
                    onChange={(e) => update(index, { title: e.target.value })}
                    className="h-8 flex-1 border-transparent shadow-none focus-visible:border-input"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label="Move up"
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => move(index, 1)}
                    disabled={index === draft.length - 1}
                    aria-label="Move down"
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 hover:text-destructive"
                    onClick={() => remove(index)}
                    disabled={draft.length <= 1}
                    aria-label="Delete scene"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>

                {isOpen && (
                  <div className="space-y-3 border-t px-4 py-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        {labels.keyPoints}
                      </label>
                      <Textarea
                        value={(outline.keyPoints || []).join('\n')}
                        onChange={(e) =>
                          // Keep blank lines while typing; cleaned up on submit.
                          update(index, { keyPoints: e.target.value.split('\n') })
                        }
                        rows={Math.min(8, Math.max(3, (outline.keyPoints || []).length + 1))}
                        className="text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        {labels.notes}
                      </label>
                      <Textarea
                        value={outline.teachingNotes || ''}
                        onChange={(e) => update(index, { teachingNotes: e.target.value })}
                        rows={6}
                        className="text-sm"
                        placeholder={labels.notesPlaceholder}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Notes + actions */}
      <div className="border-t bg-white/90 dark:bg-slate-900/90">
        <div className="mx-auto w-full max-w-4xl px-4 py-3 space-y-3">
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            placeholder={labels.revisePlaceholder}
            className="text-sm"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={onPause} disabled={isPausing}>
              <Pause className="size-3.5 mr-1.5" />
              {isPausing ? 'Pausing...' : 'Pause'}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={!feedback.trim() || draft.length === 0}
                onClick={() =>
                  onDecision({ action: 'revise', outlines: draft, feedback: feedback.trim() })
                }
              >
                <Sparkles className="size-4 mr-1.5" />
                Revise outline
              </Button>
              <Button
                disabled={draft.length === 0}
                onClick={() => onDecision({ action: 'generate', outlines: draft })}
              >
                <Play className="size-4 mr-1.5" />
                {labels.generate}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
