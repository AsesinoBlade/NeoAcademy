'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  Film,
  ImagePlus,
  Loader2,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

const ACTIVE_JOB_STORAGE_KEY = 'neoacademy-active-long-video-job';
const MAX_STARTING_IMAGE_BYTES = 20 * 1024 * 1024;

type LongVideoJobStatus =
  | 'queued'
  | 'planning'
  | 'generating'
  | 'assembling'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface RuntimeCapabilities {
  profile: 'mac-mlx' | 'windows-cuda' | 'generic';
  platform: string;
  arch: string;
  video: {
    available: boolean;
    backend: 'comfyui' | 'none';
  };
}

interface VideoHistoryItem {
  id: string;
  prompt: string;
  enhancedPrompt?: string;
  targetDurationSeconds: number;
  outputUrl: string;
  createdAt: string;
  updatedAt: string;
}

interface LongVideoJobStatusResponse {
  id: string;
  status: LongVideoJobStatus;
  prompt: string;
  targetDurationSeconds: number;
  segmentCount: number;
  completedSegments: number;
  currentSegmentIndex?: number;
  outputUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function getProgress(job: LongVideoJobStatusResponse | null): number {
  if (!job) return 0;

  switch (job.status) {
    case 'queued':
    case 'planning':
      return 5;

    case 'generating': {
      if (job.segmentCount <= 0) return 10;

      return Math.min(90, 10 + Math.round((job.completedSegments / job.segmentCount) * 80));
    }

    case 'assembling':
      return 95;

    case 'completed':
      return 100;

    case 'failed':
      return 0;

    case 'cancelled':
      return 0;

    default:
      return 0;
  }
}

function getStatusMessage(job: LongVideoJobStatusResponse | null, submitting: boolean): string {
  if (submitting) {
    return 'Planning video...';
  }

  if (!job) {
    return '';
  }

  switch (job.status) {
    case 'queued':
      return 'Video queued...';

    case 'planning':
      return 'Planning video...';

    case 'generating':
      return `Generating segment ${Math.min(
        (job.currentSegmentIndex ?? job.completedSegments) + 1,
        job.segmentCount,
      )} of ${job.segmentCount}...`;

    case 'assembling':
      return 'Assembling final video...';

    case 'completed':
      return 'Video complete';

    case 'failed':
      return 'Job failed';

    case 'cancelled':
      return 'Video generation cancelled';

    default:
      return '';
  }
}

export default function GenerateVideoPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [durationSeconds, setDurationSeconds] = useState('30');
  const [startingImage, setStartingImage] = useState<File | null>(null);
  const [startingImagePreview, setStartingImagePreview] = useState<string | null>(null);

  const [capabilities, setCapabilities] = useState<RuntimeCapabilities | null>(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [job, setJob] = useState<LongVideoJobStatusResponse | null>(null);
  const [history, setHistory] = useState<VideoHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [pendingHistoryDeleteId, setPendingHistoryDeleteId] = useState<string | null>(null);

  const isActive =
    submitting ||
    cancelling ||
    job?.status === 'queued' ||
    job?.status === 'planning' ||
    job?.status === 'generating' ||
    job?.status === 'assembling';

  const videoAvailable = capabilities?.video.available === true;

  async function loadVideoHistory() {
    try {
      const response = await fetch('/api/generate/video/long/history', {
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error('Failed to load previous videos');
      }

      const data = (await response.json()) as {
        jobs?: VideoHistoryItem[];
      };

      setHistory(data.jobs ?? []);
    } catch (error) {
      console.error(error);
      toast.error('Could not load previous videos');
    } finally {
      setHistoryLoading(false);
    }
  }

  function formatHistoryDate(value: string): string {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return '';
    }

    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  async function copyHistoryPrompt(prompt: string, label: string) {
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success(`${label} copied`);
    } catch (error) {
      console.error(error);
      toast.error(`Could not copy ${label.toLowerCase()}`);
    }
  }

  async function copyJobError() {
    const message = job?.error?.trim();

    if (!message) {
      toast.error('No error details are available');
      return;
    }

    try {
      await navigator.clipboard.writeText(message);
      toast.success('Error details copied');
    } catch (error) {
      console.error(error);
      toast.error('Could not copy error details');
    }
  }
  async function deleteHistoryVideo(jobId: string) {
    try {
      const response = await fetch(`/api/generate/video/long/history/${jobId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);

        throw new Error(data?.error || 'Failed to delete video');
      }

      setHistory((current) => current.filter((item) => item.id !== jobId));
      setPendingHistoryDeleteId(null);

      if (job?.id === jobId) {
        resetForm();
      }

      toast.success('Video deleted');
    } catch (error) {
      console.error(error);

      toast.error(error instanceof Error ? error.message : 'Failed to delete video');
    }
  }

  useEffect(() => {
    loadVideoHistory();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadCapabilities() {
      try {
        const response = await fetch('/api/local-runtime-profile', {
          cache: 'no-store',
        });

        if (!response.ok) {
          throw new Error('Failed to load runtime profile');
        }

        const data = (await response.json()) as RuntimeCapabilities;

        if (!cancelled) {
          setCapabilities(data);
        }
      } catch (error) {
        console.error(error);

        if (!cancelled) {
          toast.error('Could not determine local video capabilities');
        }
      } finally {
        if (!cancelled) {
          setCapabilitiesLoading(false);
        }
      }
    }

    loadCapabilities();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let savedJobId: string | null = null;

    try {
      savedJobId = localStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
    } catch {
      return;
    }

    if (!savedJobId) return;

    let cancelled = false;

    async function restoreJob() {
      try {
        const response = await fetch(`/api/generate/video/long/${savedJobId}`, {
          cache: 'no-store',
        });

        if (response.status === 404) {
          localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
          return;
        }

        if (!response.ok) {
          throw new Error('Failed to restore video job');
        }

        const restoredJob = (await response.json()) as LongVideoJobStatusResponse;

        if (!cancelled) {
          setJob(restoredJob);
          setPrompt(restoredJob.prompt);
          setDurationSeconds(String(restoredJob.targetDurationSeconds));
        }

        if (restoredJob.status === 'completed' || restoredJob.status === 'failed' || restoredJob.status === 'cancelled') {
          localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
        }
      } catch (error) {
        console.error(error);
      }
    }

    restoreJob();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!job) return;

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return;
    }

    const jobId = job.id;
    let cancelled = false;

    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/generate/video/long/${jobId}`, {
          cache: 'no-store',
        });

        if (!response.ok) {
          throw new Error('Failed to read video job status');
        }

        const updated = (await response.json()) as LongVideoJobStatusResponse;

        if (cancelled) return;

        setJob(updated);

        if (updated.status === 'completed' || updated.status === 'failed' || updated.status === 'cancelled') {
          try {
            localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
          } catch {
            // Ignore unavailable localStorage.
          }

        if (updated.status === 'completed') {
          toast.success('Video generation complete');
        } else if (updated.status === 'cancelled') {
          toast.info('Video generation cancelled');
        } else {
          toast.error('Video generation failed');
        }
          await loadVideoHistory();
        }
      } catch (error) {
        console.error(error);
      }
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!startingImage) {
      setStartingImagePreview(null);
      return;
    }

    const url = URL.createObjectURL(startingImage);
    setStartingImagePreview(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [startingImage]);

  function handleStartingImage(file: File | null) {
    if (!file) {
      setStartingImage(null);
      return;
    }

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Starting image must be PNG, JPEG, or WebP');
      return;
    }

    if (file.size > MAX_STARTING_IMAGE_BYTES) {
      toast.error('Starting image must be 20 MB or smaller');
      return;
    }

    setStartingImage(file);
  }

  async function handleGenerate() {
    if (!prompt.trim()) {
      toast.error('Enter a video description');
      return;
    }

    if (!videoAvailable) {
      toast.error('Video generation is not available on this machine');
      return;
    }

    setSubmitting(true);
    setJob(null);

    try {
      const modelConfig = getCurrentModelConfig();

      const formData = new FormData();

      formData.append('prompt', prompt.trim());
      formData.append('targetDurationSeconds', durationSeconds);

      if (startingImage) {
        formData.append('startingImage', startingImage);
      }

      const response = await fetch('/api/generate/video/long', {
        method: 'POST',
        headers: {
          'x-model': modelConfig.modelString,
          'x-api-key': modelConfig.apiKey,
          'x-base-url': modelConfig.baseUrl,
          'x-provider-type': modelConfig.providerType || '',
          'x-requires-api-key': modelConfig.requiresApiKey ? 'true' : 'false',
        },
        body: formData,
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || result.message || 'Failed to start video generation');
      }

      const jobId = result.jobId as string;

      try {
        localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, jobId);
      } catch {
        // Local storage is optional.
      }

      const statusResponse = await fetch(`/api/generate/video/long/${jobId}`, {
        cache: 'no-store',
      });

      if (!statusResponse.ok) {
        throw new Error('Video job started but its status could not be loaded');
      }

      setJob((await statusResponse.json()) as LongVideoJobStatusResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!job || !isActive) {
      return;
    }

    setCancelling(true);

    try {
      const response = await fetch(
        `/api/generate/video/long/${job.id}/cancel`,
        {
          method: 'POST',
        },
      );

      const result = await response.json().catch(() => null);

      if (!response.ok || !result?.success) {
        throw new Error(result?.error || 'Failed to cancel video generation');
      }

      try {
        localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
      } catch {
        // Ignore unavailable localStorage.
      }

      setJob((current) =>
        current
          ? {
              ...current,
              status: 'cancelled',
              error: undefined,
              updatedAt: new Date().toISOString(),
            }
          : current,
      );

      toast.info('Video generation cancelled');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to cancel video generation';

      toast.error(message);
    } finally {
      setCancelling(false);
    }
  }

  function resetForm() {
    setJob(null);
    setPrompt('');
    setDurationSeconds('30');
    setStartingImage(null);

    try {
      localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
    } catch {
      // Ignore unavailable localStorage.
    }
  }

  const progress = submitting ? 5 : getProgress(job);
  const statusMessage = getStatusMessage(job, submitting);

  return (
    <div className="min-h-[100dvh] bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 px-4 py-10 md:px-8">
      <div className="mx-auto w-full max-w-5xl space-y-8">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => router.push('/')}
          className="gap-2 px-0 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to NeoAcademy
        </Button>
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Film className="size-5" />
            </div>

            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Generate Video</h1>

              <p className="text-sm text-muted-foreground">
                Create a long-form video from a description, optionally beginning from an image.
              </p>
            </div>
          </div>
        </div>

        {!capabilitiesLoading && capabilities && !videoAvailable && (
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="flex items-start gap-3 pt-6">
              <AlertCircle className="mt-0.5 size-5 shrink-0 text-amber-500" />

              <div className="space-y-1">
                <p className="font-medium">Video generation is not available on this machine</p>

                <p className="text-sm text-muted-foreground">
                  This NeoAcademy installation uses the{' '}
                  <span className="font-mono">{capabilities.profile}</span> runtime profile.
                  Long-video generation is available on the Windows/CUDA system.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card>
            <CardHeader>
              <CardTitle>Video description</CardTitle>

              <CardDescription>
                Describe the subject, action, environment, and camera behavior you want.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="video-prompt">Prompt</Label>

                <Textarea
                  id="video-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="A cheerful cartoon sheep stands in a sunny pasture and waves toward the camera..."
                  rows={7}
                  disabled={isActive || !videoAvailable}
                  className="resize-y"
                />
              </div>

              <div className="space-y-2">
                <Label>Video length</Label>

                <Select
                  value={durationSeconds}
                  onValueChange={setDurationSeconds}
                  disabled={isActive || !videoAvailable}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>

                  <SelectContent>
                    <SelectItem value="5">5 seconds</SelectItem>

                    <SelectItem value="10">10 seconds</SelectItem>

                    <SelectItem value="15">15 seconds</SelectItem>

                    <SelectItem value="20">20 seconds</SelectItem>

                    <SelectItem value="30">30 seconds</SelectItem>

                    <SelectItem value="45">45 seconds</SelectItem>

                    <SelectItem value="60">1 minute</SelectItem>

                    <SelectItem value="120">2 minutes</SelectItem>

                    <SelectItem value="180">3 minutes</SelectItem>

                    <SelectItem value="240">4 minutes</SelectItem>

                    <SelectItem value="300">5 minutes</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Starting image</Label>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  disabled={isActive || !videoAvailable}
                  onChange={(event) => {
                    handleStartingImage(event.target.files?.[0] ?? null);

                    event.target.value = '';
                  }}
                />

                {startingImagePreview ? (
                  <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-muted">
                    <img
                      src={startingImagePreview}
                      alt="Starting image preview"
                      className="aspect-video w-full object-contain"
                    />

                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      className="absolute right-2 top-2 size-8 rounded-full"
                      disabled={isActive}
                      onClick={() => setStartingImage(null)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={isActive || !videoAvailable}
                    onClick={() => fileInputRef.current?.click()}
                    className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/70 bg-muted/30 text-muted-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <div className="flex size-11 items-center justify-center rounded-full bg-background shadow-sm">
                      <ImagePlus className="size-5" />
                    </div>

                    <div className="text-center">
                      <p className="text-sm font-medium text-foreground/80">
                        Add an optional starting image
                      </p>

                      <p className="mt-1 text-xs">PNG, JPEG, or WebP · maximum 20 MB</p>
                    </div>
                  </button>
                )}
              </div>

              <Button
                type="button"
                className="w-full"
                size="lg"
                disabled={!videoAvailable || capabilitiesLoading || isActive || !prompt.trim()}
                onClick={handleGenerate}
              >
                {isActive ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Film className="mr-2 size-4" />
                    Generate Video
                  </>
                )}
              </Button>
              {job &&
                (job.status === 'queued' ||
                  job.status === 'planning' ||
                  job.status === 'generating' ||
                  job.status === 'assembling') && (
                  <Button
                    type="button"
                    variant="destructive"
                    className="w-full"
                    size="lg"
                    disabled={cancelling}
                    onClick={handleCancel}
                  >
                    {cancelling ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Cancelling...
                      </>
                    ) : (
                      'Cancel Video'
                    )}
                  </Button>
                )}
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Progress</CardTitle>

                <CardDescription>
                  Long videos are generated in five-second segments and assembled automatically.
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-4">
                {capabilitiesLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Checking local video capability...
                  </div>
                ) : job || submitting ? (
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-muted-foreground">{statusMessage}</span>

                        <span className="font-mono text-xs">{progress}%</span>
                      </div>

                      <Progress value={progress} />
                    </div>

                    {job && job.segmentCount > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Segments: {job.completedSegments}/{job.segmentCount}
                      </p>
                    )}

                    {job?.status === 'failed' && (
                      <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-medium text-destructive">
                            Job failed
                          </p>

                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!job.error}
                            onClick={copyJobError}
                            className="shrink-0"
                          >
                            <Copy className="mr-2 size-4" />
                            Copy error details
                          </Button>
                        </div>

                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Configure the video and press Generate Video.
                  </p>
                )}
              </CardContent>
            </Card>

            {job?.status === 'completed' && job.outputUrl && (
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-5 text-green-500" />
                    <CardTitle>Finished video</CardTitle>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  <video
                    key={job.outputUrl}
                    src={job.outputUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="aspect-video w-full rounded-xl bg-black"
                  />

                  <div className="grid grid-cols-2 gap-2">
                    <Button type="button" variant="outline" onClick={resetForm}>
                      New Video
                    </Button>

                    <Button asChild>
                      <a href={job.outputUrl} download="neoacademy-video.mp4">
                        <Download className="mr-2 size-4" />
                        Download
                      </a>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
        {(historyLoading || history.length > 0) && (
          <section className="space-y-5 pt-4">
            <div className="flex items-center gap-4">
              <div className="h-px flex-1 bg-border/50" />

              <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
                <Film className="size-4" />
                <span>Previous Videos</span>

                {!historyLoading && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums">
                    {history.length}
                  </span>
                )}
              </div>

              <div className="h-px flex-1 bg-border/50" />
            </div>

            {historyLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading previous videos...
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
                {history.map((item) => {
                  const confirmingDelete = pendingHistoryDeleteId === item.id;

                  return (
                    <div key={item.id} className="group min-w-0">
                      <div className="relative aspect-video overflow-hidden rounded-2xl bg-black">
                        <video
                          src={`${item.outputUrl}#t=0.1`}
                          controls={!confirmingDelete}
                          playsInline
                          preload="metadata"
                          className="size-full object-cover"
                        />

                        {!confirmingDelete && (
                          <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <Button
                              type="button"
                              size="icon"
                              variant="secondary"
                              className="size-8 rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70 hover:text-white"
                              onClick={() =>
                                copyHistoryPrompt(item.prompt, 'Original prompt')
                              }
                              title="Copy original prompt"
                            >
                              <Copy className="size-4" />
                            </Button>

                            {item.enhancedPrompt && (
                              <Button
                                type="button"
                                size="icon"
                                variant="secondary"
                                className="size-8 rounded-full bg-violet-600/80 text-white backdrop-blur-sm hover:bg-violet-600 hover:text-white"
                                onClick={() =>
                                  copyHistoryPrompt(
                                    item.enhancedPrompt!,
                                    'Enhanced prompt',
                                  )
                                }
                                title="Copy enhanced prompt"
                              >
                                <Copy className="size-4" />
                              </Button>
                            )}

                            <Button
                              asChild
                              type="button"
                              size="icon"
                              variant="secondary"
                              className="size-8 rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70 hover:text-white"
                            >
                              <a
                                href={item.outputUrl}
                                download={`neoacademy-video-${item.id}.mp4`}
                                title="Download video"
                              >
                                <Download className="size-4" />
                              </a>
                            </Button>

                            <Button
                              type="button"
                              size="icon"
                              variant="secondary"
                              className="size-8 rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-destructive hover:text-white"
                              onClick={() => setPendingHistoryDeleteId(item.id)}
                              title="Delete video"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        )}

                        {confirmingDelete && (
                          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60 backdrop-blur-[6px]">
                            <span className="text-sm font-medium text-white">
                              Delete this video?
                            </span>

                            <div className="flex gap-2">
                              <button
                                type="button"
                                className="rounded-lg bg-white/15 px-3.5 py-1.5 text-xs font-medium text-white/90 transition-colors hover:bg-white/25"
                                onClick={() => setPendingHistoryDeleteId(null)}
                              >
                                Cancel
                              </button>

                              <button
                                type="button"
                                className="rounded-lg bg-red-500/90 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500"
                                onClick={() => deleteHistoryVideo(item.id)}
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="mt-2.5 min-w-0 px-1">
                        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="rounded-full bg-violet-100 px-2 py-0.5 font-medium text-violet-600 dark:bg-violet-900/30 dark:text-violet-400">
                            {item.targetDurationSeconds < 60
                              ? `${item.targetDurationSeconds} sec`
                              : `${item.targetDurationSeconds / 60} min`}
                          </span>

                          <span>{formatHistoryDate(item.createdAt)}</span>
                        </div>

                        <p
                          className="line-clamp-2 text-sm font-medium leading-snug text-foreground/90"
                          title={item.prompt}
                        >
                          {item.prompt}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
