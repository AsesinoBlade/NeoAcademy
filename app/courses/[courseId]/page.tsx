'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle, Loader2, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface Scene {
  id: string;
  title: string;
  type: string;
  content: Record<string, unknown>;
  speakerNotes: string;
  audioPath?: string;
}

interface CoursePackage {
  courseId: string;
  title: string;
  topic: string;
  level?: string;
  scenes: Scene[];
}

export default function CoursePage() {
  const { courseId } = useParams<{ courseId: string }>();
  const router = useRouter();
  const [pkg, setPkg] = useState<CoursePackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [audioPlaying, setAudioPlaying] = useState(false);

  useEffect(() => {
    fetch(`/api/courses/${courseId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.package) setPkg(data.package);
        else toast.error('Course not available');
      })
      .catch(() => toast.error('Failed to load course'))
      .finally(() => setLoading(false));
  }, [courseId]);

  const scene = pkg?.scenes[currentIdx];

  function playAudio() {
    if (!scene?.audioPath) return;
    const audio = new Audio(`/api/courses/${courseId}/audio/${scene.id}`);
    setAudioPlaying(true);
    audio.onended = () => setAudioPlaying(false);
    audio.onerror = () => setAudioPlaying(false);
    audio.play().catch(() => setAudioPlaying(false));
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!pkg) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-4">
        <p className="text-muted-foreground">Course not found or not ready</p>
        <Button variant="outline" onClick={() => router.push('/courses')}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to courses
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="mx-auto max-w-4xl flex items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => router.push('/courses')}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-sm font-semibold line-clamp-1">{pkg.title}</h1>
              {pkg.level && <p className="text-xs text-muted-foreground">{pkg.level}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{currentIdx + 1}</span>
            <span>/</span>
            <span>{pkg.scenes.length}</span>
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-secondary">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${((currentIdx + 1) / pkg.scenes.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Scene content */}
      {scene && (
        <div className="flex-1 mx-auto w-full max-w-4xl px-6 py-8 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold">{scene.title}</h2>
              <Badge variant="outline" className="mt-1 text-xs capitalize">
                {scene.type}
              </Badge>
            </div>
            {scene.audioPath && (
              <Button
                variant="outline"
                size="sm"
                onClick={playAudio}
                disabled={audioPlaying}
                className="shrink-0"
              >
                {audioPlaying ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
                {audioPlaying ? 'Playing…' : 'Play audio'}
              </Button>
            )}
          </div>

          {/* Scene type renderer */}
          <SceneRenderer key={scene.id} scene={scene} />

          {/* Speaker notes */}
          {scene.speakerNotes && (
            <Card className="bg-muted/50">
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium text-muted-foreground">Lecture</CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <p className="text-sm leading-relaxed whitespace-pre-line">{scene.speakerNotes}</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Navigation */}
      <div className="border-t bg-card">
        <div className="mx-auto max-w-4xl flex items-center justify-between px-6 py-4">
          <Button
            variant="outline"
            onClick={() => setCurrentIdx((i) => Math.max(0, i - 1))}
            disabled={currentIdx === 0}
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Previous
          </Button>

          {/* Scene dots */}
          <div className="flex gap-1.5">
            {pkg.scenes.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrentIdx(i)}
                className={cn(
                  'h-2 w-2 rounded-full transition-colors',
                  i === currentIdx ? 'bg-primary' : i < currentIdx ? 'bg-primary/40' : 'bg-border',
                )}
              />
            ))}
          </div>

          {currentIdx < pkg.scenes.length - 1 ? (
            <Button onClick={() => setCurrentIdx((i) => i + 1)}>
              Next <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          ) : (
            <Button onClick={() => router.push('/courses')}>
              <CheckCircle className="h-4 w-4 mr-1" /> Finish
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scene renderer — handles slides, quiz, and interactive types
// ---------------------------------------------------------------------------

// Content shapes produced by the pre-generation engine. Older courses only have
// heading/bullets/example and plain-string steps; everything new is optional.
interface SlideCode {
  language?: string;
  code: string;
  caption?: string;
}

interface SlideData {
  heading: string;
  explanation?: string;
  bullets?: string[];
  steps?: string[];
  code?: SlideCode | string;
  output?: string;
  example?: string;
}

interface Exercise {
  prompt: string;
  starterCode?: string;
  hints?: string[];
  solution?: string;
  solutionCode?: string;
}

interface LabStep {
  instruction: string;
  code?: string;
  expected?: string;
}

function CodeBlock({ code, caption, tone = 'code' }: { code: string; caption?: string; tone?: 'code' | 'output' }) {
  return (
    <div className="space-y-1">
      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
      <pre
        className={cn(
          'rounded-md px-4 py-3 text-[13px] leading-relaxed overflow-x-auto font-mono',
          tone === 'code' ? 'bg-zinc-900 text-zinc-100' : 'bg-muted text-foreground border',
        )}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Prose({ text }: { text?: string }) {
  if (!text) return null;
  return <p className="text-sm leading-relaxed whitespace-pre-line">{text}</p>;
}

function Reveal({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
        {open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
      </Button>
      {open && <div className="space-y-2">{children}</div>}
    </div>
  );
}

function ExerciseCard({ exercise, title = 'Your turn' }: { exercise: Exercise; title?: string }) {
  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Prose text={exercise.prompt} />
        {exercise.starterCode && <CodeBlock code={exercise.starterCode} caption="Starter code" />}
        {exercise.hints && exercise.hints.length > 0 && (
          <Reveal label="Hints">
            <ul className="list-disc pl-5 text-sm space-y-1">
              {exercise.hints.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          </Reveal>
        )}
        {(exercise.solution || exercise.solutionCode) && (
          <Reveal label="Solution">
            <Prose text={exercise.solution} />
            {exercise.solutionCode && <CodeBlock code={exercise.solutionCode} />}
          </Reveal>
        )}
      </CardContent>
    </Card>
  );
}

function SceneRenderer({ scene }: { scene: Scene }) {
  const content = scene.content;

  if (scene.type === 'slides') {
    const slides = (content.slides as SlideData[]) || [];
    const exercise = content.exercise as Exercise | undefined;
    const takeaways = (content.keyTakeaways as string[]) || [];
    return (
      <div className="space-y-4">
        {slides.map((slide, i) => {
          const code =
            typeof slide.code === 'string' ? { code: slide.code } : (slide.code as SlideCode | undefined);
          return (
            <Card key={i}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{slide.heading}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Prose text={slide.explanation} />
                {slide.bullets && slide.bullets.length > 0 && (
                  <ul className="space-y-1">
                    {slide.bullets.map((b, j) => (
                      <li key={j} className="flex items-start gap-2 text-sm">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                        {b}
                      </li>
                    ))}
                  </ul>
                )}
                {slide.steps && slide.steps.length > 0 && (
                  <ol className="space-y-1 rounded-md bg-muted px-4 py-3 font-mono text-[13px]">
                    {slide.steps.map((st, j) => (
                      <li key={j}>
                        <span className="text-muted-foreground mr-2">{j + 1}.</span>
                        {st}
                      </li>
                    ))}
                  </ol>
                )}
                {code?.code && <CodeBlock code={code.code} caption={code.caption} />}
                {slide.output && <CodeBlock code={slide.output} caption="Result" tone="output" />}
                {slide.example && (
                  <div className="rounded-md bg-muted px-3 py-2 text-sm whitespace-pre-line">
                    <span className="font-medium text-muted-foreground text-xs">Example: </span>
                    {slide.example}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
        {exercise?.prompt && <ExerciseCard exercise={exercise} />}
        {takeaways.length > 0 && (
          <Card className="bg-muted/40">
            <CardContent className="py-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Remember:</p>
              {takeaways.map((t, i) => (
                <p key={i} className="text-sm flex gap-2">
                  <CheckCircle className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                  {t}
                </p>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  if (scene.type === 'quiz') {
    return <QuizRenderer questions={(content.questions as QuizQuestion[]) || []} />;
  }

  if (scene.type === 'interactive') {
    const activity = content.activity as string;
    const steps = (content.steps as (string | LabStep)[]) || [];
    const outcomes = (content.outcomes as string[]) || [];
    const challenge = content.challenge as
      | { prompt: string; solution?: string; solutionCode?: string }
      | undefined;
    return (
      <div className="space-y-4">
        {activity && <Prose text={activity} />}
        {steps.length > 0 && (
          <div className="space-y-4">
            {steps.map((raw, i) => {
              const step: LabStep = typeof raw === 'string' ? { instruction: raw } : raw;
              return (
                <div key={i} className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0 space-y-2 pt-0.5">
                    <Prose text={step.instruction} />
                    {step.code && <CodeBlock code={step.code} />}
                    {step.expected && (
                      <CodeBlock code={step.expected} caption="You should see" tone="output" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {challenge?.prompt && <ExerciseCard exercise={challenge} title="Stretch challenge" />}
        {outcomes.length > 0 && (
          <Card className="border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/20">
            <CardContent className="py-3 space-y-1">
              <p className="text-xs font-medium text-green-700 dark:text-green-400">
                Learning outcomes:
              </p>
              {outcomes.map((o, i) => (
                <p key={i} className="text-sm flex gap-2">
                  <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                  {o}
                </p>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  // Fallback: raw JSON
  return (
    <pre className="rounded-md bg-muted p-4 text-xs overflow-auto">
      {JSON.stringify(content, null, 2)}
    </pre>
  );
}

interface QuizQuestion {
  question: string;
  code?: string;
  options: string[];
  correct: number;
  explanation: string;
}

function QuizRenderer({ questions }: { questions: QuizQuestion[] }) {
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState<Record<number, boolean>>({});

  return (
    <div className="space-y-6">
      {questions.map((q, i) => (
        <Card key={i}>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium whitespace-pre-line">
              {i + 1}. {q.question}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {q.code && <CodeBlock code={q.code} />}
            {q.options.map((opt, j) => {
              const isSelected = answers[i] === j;
              const isSubmitted = submitted[i];
              const isCorrect = j === q.correct;
              return (
                <button
                  key={j}
                  className={cn(
                    'w-full rounded-lg border px-4 py-2.5 text-left text-sm transition-colors',
                    !isSubmitted && 'hover:bg-accent',
                    isSelected && !isSubmitted && 'border-primary bg-primary/5',
                    isSubmitted && isCorrect && 'border-green-500 bg-green-50 dark:bg-green-950/30',
                    isSubmitted &&
                      isSelected &&
                      !isCorrect &&
                      'border-destructive bg-destructive/5',
                  )}
                  onClick={() => !isSubmitted && setAnswers({ ...answers, [i]: j })}
                >
                  {opt}
                </button>
              );
            })}

            {answers[i] !== undefined && !submitted[i] && (
              <Button
                size="sm"
                className="mt-2"
                onClick={() => setSubmitted({ ...submitted, [i]: true })}
              >
                Submit answer
              </Button>
            )}

            {submitted[i] && (
              <div
                className={cn(
                  'mt-2 rounded-lg px-3 py-2 text-sm whitespace-pre-line',
                  answers[i] === q.correct
                    ? 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400'
                    : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400',
                )}
              >
                {answers[i] === q.correct ? '✓ Correct! ' : '✗ Incorrect. '}
                {q.explanation}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
