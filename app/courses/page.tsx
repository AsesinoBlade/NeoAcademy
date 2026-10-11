'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { BookOpen, ChevronRight, Loader2, Plus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { PreGenerationProgress } from '@/lib/server/pre-generation-engine';

interface Course {
  id: string;
  title: string;
  topic: string;
  level: string | null;
  sceneCount: number;
  status: string;
  createdAt: number;
}

export default function CoursesPage() {
  const router = useRouter();
  const [courses, setCourses] = useState<Course[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(true);
  const [genOpen, setGenOpen] = useState(false);

  // Generation form
  const [topic, setTopic] = useState('');
  const [level, setLevel] = useState('GCSE');
  const [numScenes, setNumScenes] = useState('16');
  const [useKnowledge, setUseKnowledge] = useState(true);
  const [useWebSearch, setUseWebSearch] = useState(true);
  const [highQuality, setHighQuality] = useState(false);

  // Generation progress
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<PreGenerationProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function loadCourses() {
    const res = await fetch('/api/courses');
    const data = await res.json();
    setCourses(data.courses || []);
    setLoadingCourses(false);
  }

  useEffect(() => {
    loadCourses();
  }, []);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setGenerating(true);
    setProgress({ step: 'initializing', progress: 0, message: 'Starting…' });

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch('/api/generate-course', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          level,
          numScenes: parseInt(numScenes),
          useKnowledgeBase: useKnowledge,
          useWebSearch,
          highQuality,
        }),
        signal: abort.signal,
      });

      const reader = res.body!.getReader();
      const dec = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const text = dec.decode(value);
        const lines = text.split('\n').filter((l) => l.startsWith('data: '));
        for (const line of lines) {
          const data = JSON.parse(line.slice(6)) as PreGenerationProgress;
          setProgress(data);

          if (data.step === 'complete') {
            toast.success(`Course "${topic}" generated!`);
            setGenOpen(false);
            setGenerating(false);
            setTopic('');
            await loadCourses();
            if (data.courseId) router.push(`/courses/${data.courseId}`);
            return;
          }

          if (data.step === 'error') {
            toast.error(data.error || 'Generation failed');
            setGenerating(false);
            return;
          }
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        toast.error('Generation failed');
      }
    } finally {
      setGenerating(false);
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
    setGenerating(false);
    setProgress(null);
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="mx-auto max-w-5xl flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <BookOpen className="h-4 w-4" />
            </div>
            <h1 className="text-xl font-semibold">My Courses</h1>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => router.push('/knowledge')}>
              <Upload className="h-4 w-4 mr-1" /> Knowledge Base
            </Button>
            <Dialog
              open={genOpen}
              onOpenChange={(o) => {
                if (!generating) setGenOpen(o);
              }}
            >
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="h-4 w-4 mr-1" /> Generate Course
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Generate a new course</DialogTitle>
                  <DialogDescription>
                    NeoAcademy will create a full interactive course. This takes 2–5 minutes.
                  </DialogDescription>
                </DialogHeader>

                {!generating ? (
                  <form onSubmit={handleGenerate} className="space-y-4 pt-2">
                    <div className="space-y-2">
                      <Label>Topic</Label>
                      <Input
                        placeholder="e.g. Photosynthesis, Quadratic Equations, World War II…"
                        value={topic}
                        onChange={(e) => setTopic(e.target.value)}
                        required
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label>Level</Label>
                        <Select value={level} onValueChange={setLevel}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="GCSE">GCSE</SelectItem>
                            <SelectItem value="A-Level">A-Level</SelectItem>
                            <SelectItem value="University">University</SelectItem>
                            <SelectItem value="General">General</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Scenes</Label>
                        <Select value={numScenes} onValueChange={setNumScenes}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {[8, 12, 16, 20, 30, 40].map((n) => (
                              <SelectItem key={n} value={String(n)}>
                                {n} scenes
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm">Use knowledge base</Label>
                        <Switch checked={useKnowledge} onCheckedChange={setUseKnowledge} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-sm">Search the web for latest info</Label>
                        <Switch checked={useWebSearch} onCheckedChange={setUseWebSearch} />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label className="text-sm">
                          High quality{' '}
                          <span className="text-muted-foreground text-xs">
                            (slower, uses Gemini Flash)
                          </span>
                        </Label>
                        <Switch checked={highQuality} onCheckedChange={setHighQuality} />
                      </div>
                    </div>
                    <Button type="submit" className="w-full">
                      Generate course
                    </Button>
                  </form>
                ) : (
                  <div className="space-y-4 pt-2">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{progress?.message}</span>
                        <span className="font-mono text-xs">{progress?.progress}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-secondary overflow-hidden">
                        <div
                          className="h-full bg-primary transition-all duration-500"
                          style={{ width: `${progress?.progress ?? 0}%` }}
                        />
                      </div>
                      {progress?.totalScenes != null && (
                        <p className="text-xs text-muted-foreground">
                          Scenes: {progress.scenesComplete}/{progress.totalScenes}
                        </p>
                      )}
                    </div>
                    <Button variant="outline" size="sm" onClick={handleCancel} className="w-full">
                      Cancel
                    </Button>
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      {/* Course grid */}
      <div className="mx-auto max-w-5xl px-6 py-8">
        {loadingCourses ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading courses…
          </div>
        ) : courses.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-20 text-center">
            <BookOpen className="h-12 w-12 text-muted-foreground/50" />
            <div>
              <p className="text-lg font-medium">No courses yet</p>
              <p className="text-sm text-muted-foreground">
                Generate your first course to get started
              </p>
            </div>
            <Button onClick={() => setGenOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Generate first course
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {courses.map((c) => (
              <Card
                key={c.id}
                className={cn(
                  'cursor-pointer transition-shadow hover:shadow-md',
                  c.status !== 'ready' && 'opacity-60 cursor-default',
                )}
                onClick={() => c.status === 'ready' && router.push(`/courses/${c.id}`)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-sm leading-snug">{c.title}</CardTitle>
                    <Badge
                      variant={
                        c.status === 'ready'
                          ? 'default'
                          : c.status === 'failed'
                            ? 'destructive'
                            : 'secondary'
                      }
                      className="shrink-0 text-xs"
                    >
                      {c.status}
                    </Badge>
                  </div>
                  {c.level && <CardDescription className="text-xs">{c.level}</CardDescription>}
                </CardHeader>
                <CardContent className="pb-2">
                  <p className="text-xs text-muted-foreground">{c.sceneCount} scenes</p>
                </CardContent>
                {c.status === 'ready' && (
                  <CardFooter className="pt-0">
                    <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                      Start learning <ChevronRight className="h-3 w-3" />
                    </Button>
                  </CardFooter>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
