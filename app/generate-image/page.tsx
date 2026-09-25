'use client';

import {
  useEffect,
  useRef,
  useState,
} from 'react';

import { useRouter } from 'next/navigation';

import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  ImageIcon,
  ImagePlus,
  Loader2,
  Trash2,
} from 'lucide-react';

import { toast } from 'sonner';

import {
  Button,
} from '@/components/ui/button';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import {
  Label,
} from '@/components/ui/label';

import {
  Progress,
} from '@/components/ui/progress';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import {
  Textarea,
} from '@/components/ui/textarea';

const ACTIVE_JOB_STORAGE_KEY =
  'neoacademy-active-image-job';

const MAX_IMAGE_BYTES =
  20 * 1024 * 1024;

const IMAGE_RESOLUTIONS = [
  // Square
  {
    key: '1024x1024',
    width: 1024,
    height: 1024,
    label: '1024 × 1024 · Square',
  },
  {
    key: '1280x1280',
    width: 1280,
    height: 1280,
    label: '1280 × 1280 · Square',
  },
  {
    key: '1536x1536',
    width: 1536,
    height: 1536,
    label: '1536 × 1536 · Square',
  },

  // Landscape 16:9
  {
    key: '1280x720',
    width: 1280,
    height: 720,
    label: '1280 × 720 · HD · 16:9',
  },
  {
    key: '1536x864',
    width: 1536,
    height: 864,
    label: '1536 × 864 · 16:9',
  },
  {
    key: '1920x1080',
    width: 1920,
    height: 1080,
    label: '1920 × 1080 · Full HD · 16:9',
  },

  // Landscape 16:10
  {
    key: '1280x800',
    width: 1280,
    height: 800,
    label: '1280 × 800 · 16:10',
  },
  {
    key: '1600x1000',
    width: 1600,
    height: 1000,
    label: '1600 × 1000 · 16:10',
  },
  {
    key: '1920x1200',
    width: 1920,
    height: 1200,
    label: '1920 × 1200 · WUXGA · 16:10',
  },

  // Other landscape
  {
    key: '1152x768',
    width: 1152,
    height: 768,
    label: '1152 × 768 · Landscape 3:2',
  },
  {
    key: '1024x768',
    width: 1024,
    height: 768,
    label: '1024 × 768 · Landscape 4:3',
  },

  // Portrait
  {
    key: '768x1024',
    width: 768,
    height: 1024,
    label: '768 × 1024 · Portrait 3:4',
  },
  {
    key: '768x1152',
    width: 768,
    height: 1152,
    label: '768 × 1152 · Portrait 2:3',
  },
  {
    key: '720x1280',
    width: 720,
    height: 1280,
    label: '720 × 1280 · Portrait 9:16',
  },
  {
    key: '1080x1920',
    width: 1080,
    height: 1920,
    label: '1080 × 1920 · Full HD Portrait · 9:16',
  },
];

type ImageJobStatus =
  | 'queued'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled';

type ImageJobMode =
  | 'text-to-image'
  | 'single-image-edit'
  | 'two-image-edit';

interface ImageJobStatusResponse {
  id: string;
  status: ImageJobStatus;
  mode: ImageJobMode;
  prompt: string;
  enhancePrompt?: boolean;
  enhancedPrompt?: string;
  secondPrompt?: string;
  enhanceSecondPrompt?: boolean;
  enhancedSecondPrompt?: string;
  width: number;
  height: number;
  outputUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface ImageHistoryItem {
  id: string;
  mode: ImageJobMode;
  prompt: string;
  enhancePrompt?: boolean;
  enhancedPrompt?: string;
  secondPrompt?: string;
  enhanceSecondPrompt?: boolean;
  enhancedSecondPrompt?: string;
  width: number;
  height: number;
  status: 'completed' | 'failed';
  outputUrl?: string;
  error?: string;
  logUrl: string;
  createdAt: string;
  updatedAt: string;
}

function getProgress(
  job: ImageJobStatusResponse | null,
  submitting: boolean,
): number {
  if (submitting) {
    return 5;
  }

  if (!job) {
    return 0;
  }

  switch (job.status) {
    case 'queued':
      return 10;

    case 'generating':
      return 60;

    case 'completed':
      return 100;

    case 'failed':
    case 'cancelled':
      return 0;

    default:
      return 0;
  }
}

function getStatusMessage(
  job: ImageJobStatusResponse | null,
  submitting: boolean,
): string {
  if (submitting) {
    return 'Starting image job...';
  }

  if (!job) {
    return '';
  }

  switch (job.status) {
    case 'queued':
      return 'Image queued...';

    case 'generating':
      return 'Generating image...';

    case 'completed':
      return 'Image complete';

    case 'failed':
      return 'Job failed';

    case 'cancelled':
      return 'Image generation cancelled';

    default:
      return '';
  }
}

function formatHistoryDate(
  value: string,
): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleDateString(
    undefined,
    {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    },
  );
}

function modeLabel(
  mode: ImageJobMode,
): string {
  switch (mode) {
    case 'single-image-edit':
      return 'Edit';

    case 'two-image-edit':
      return 'Combine';

    default:
      return 'Generate';
  }
}

export default function GenerateImagePage() {
  const router = useRouter();

  const image1InputRef =
    useRef<HTMLInputElement>(null);

  const image2InputRef =
    useRef<HTMLInputElement>(null);

  const [prompt, setPrompt] =
    useState('');

  const [secondPrompt, setSecondPrompt] =
    useState('');

  /*
   * Standalone creative generation defaults to enhancement ON.
   * Classroom requests will default OFF unless their planner explicitly opts in.
   */
  const [enhancePrompt, setEnhancePrompt] =
    useState(true);

  const [
    enhanceSecondPrompt,
    setEnhanceSecondPrompt,
  ] = useState(true);

  const [resolutionKey, setResolutionKey] =
    useState('1024x1024');

  const [image1, setImage1] =
    useState<File | null>(null);

  const [image2, setImage2] =
    useState<File | null>(null);

  const [
    image1Preview,
    setImage1Preview,
  ] = useState<string | null>(null);

  const [
    image2Preview,
    setImage2Preview,
  ] = useState<string | null>(null);

  const [submitting, setSubmitting] =
    useState(false);

  const [job, setJob] =
    useState<ImageJobStatusResponse | null>(
      null,
    );

  const [history, setHistory] =
    useState<ImageHistoryItem[]>([]);

  const [
    historyLoading,
    setHistoryLoading,
  ] = useState(true);

  const [
    pendingHistoryDeleteId,
    setPendingHistoryDeleteId,
  ] = useState<string | null>(null);

  const isActive =
    submitting ||
    job?.status === 'queued' ||
    job?.status === 'generating';

  const progress =
    getProgress(job, submitting);

  const statusMessage =
    getStatusMessage(job, submitting);

  const resolution =
    IMAGE_RESOLUTIONS.find(
      (item) =>
        item.key === resolutionKey,
    ) ?? IMAGE_RESOLUTIONS[0];

  async function loadHistory() {
    try {
      const response =
        await fetch(
          '/api/generate/image/long/history',
          {
            cache: 'no-store',
          },
        );

      if (!response.ok) {
        throw new Error(
          'Failed to load image history',
        );
      }

      const data =
        (await response.json()) as {
          jobs?: ImageHistoryItem[];
        };

      setHistory(
        data.jobs ?? [],
      );
    } catch (error) {
      console.error(error);

      toast.error(
        'Could not load image history',
      );
    } finally {
      setHistoryLoading(false);
    }
  }

  async function copyText(
    text: string,
    label: string,
  ) {
    try {
      await navigator.clipboard.writeText(
        text,
      );

      toast.success(
        `${label} copied`,
      );
    } catch (error) {
      console.error(error);

      toast.error(
        `Could not copy ${label.toLowerCase()}`,
      );
    }
  }

  function validateImage(
    file: File,
    label: string,
  ): boolean {
    if (
      ![
        'image/png',
        'image/jpeg',
        'image/webp',
      ].includes(file.type)
    ) {
      toast.error(
        `${label} must be PNG, JPEG, or WebP`,
      );

      return false;
    }

    if (
      file.size > MAX_IMAGE_BYTES
    ) {
      toast.error(
        `${label} must be 20 MB or smaller`,
      );

      return false;
    }

    return true;
  }

  function handleImage1(
    file: File | null,
  ) {
    if (!file) {
      setImage1(null);
      setImage2(null);
      setSecondPrompt('');
      return;
    }

    if (
      !validateImage(
        file,
        'First image',
      )
    ) {
      return;
    }

    setImage1(file);
  }

  function handleImage2(
    file: File | null,
  ) {
    if (!file) {
      setImage2(null);
      setSecondPrompt('');
      return;
    }

    if (!image1) {
      toast.error(
        'Choose the first image before adding a second image',
      );

      return;
    }

    if (
      !validateImage(
        file,
        'Second image',
      )
    ) {
      return;
    }

    setImage2(file);
  }

  function resetForm() {
    setPrompt('');
    setSecondPrompt('');
    setEnhancePrompt(true);
    setEnhanceSecondPrompt(true);
    setImage1(null);
    setImage2(null);
    setResolutionKey(
      '1024x1024',
    );
    setJob(null);

    try {
      localStorage.removeItem(
        ACTIVE_JOB_STORAGE_KEY,
      );
    } catch {
      // Optional.
    }
  }

  async function handleGenerate() {
    if (!prompt.trim()) {
      toast.error(
        'Enter an image description',
      );

      return;
    }

    if (
      image2 &&
      !secondPrompt.trim()
    ) {
      toast.error(
        'Enter Prompt 2 for the second image',
      );

      return;
    }

    setSubmitting(true);
    setJob(null);

    try {
      const formData =
        new FormData();

      formData.append(
        'prompt',
        prompt.trim(),
      );

      formData.append(
        'enhancePrompt',
        enhancePrompt
          ? 'true'
          : 'false',
      );

      formData.append(
        'width',
        String(resolution.width),
      );

      formData.append(
        'height',
        String(resolution.height),
      );

      if (image1) {
        formData.append(
          'image1',
          image1,
        );
      }

      if (image2) {
        formData.append(
          'image2',
          image2,
        );

        formData.append(
          'secondPrompt',
          secondPrompt.trim(),
        );

        formData.append(
          'enhanceSecondPrompt',
          enhanceSecondPrompt
            ? 'true'
            : 'false',
        );
      }

      const response =
        await fetch(
          '/api/generate/image/long',
          {
            method: 'POST',
            body: formData,
          },
        );

      const result =
        await response.json();

      if (
        !response.ok ||
        !result.success
      ) {
        throw new Error(
          result.error ||
          result.message ||
          'Failed to start image generation',
        );
      }

      const jobId =
        result.jobId as string;

      try {
        localStorage.setItem(
          ACTIVE_JOB_STORAGE_KEY,
          jobId,
        );
      } catch {
        // Optional.
      }

      const statusResponse =
        await fetch(
          `/api/generate/image/long/${jobId}`,
          {
            cache: 'no-store',
          },
        );

      if (!statusResponse.ok) {
        throw new Error(
          'Image job started but status could not be loaded',
        );
      }

      setJob(
        (await statusResponse.json()) as
          ImageJobStatusResponse,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteHistoryItem(
    jobId: string,
  ) {
    try {
      const response =
        await fetch(
          `/api/generate/image/long/history/${jobId}`,
          {
            method: 'DELETE',
          },
        );

      const result =
        await response
          .json()
          .catch(() => null);

      if (!response.ok) {
        throw new Error(
          result?.error ||
          'Failed to delete image job',
        );
      }

      setHistory(
        (current) =>
          current.filter(
            (item) =>
              item.id !== jobId,
          ),
      );

      setPendingHistoryDeleteId(
        null,
      );

      if (job?.id === jobId) {
        resetForm();
      }

      toast.success(
        'Image job deleted',
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to delete image job',
      );
    }
  }

  async function deleteFailedJob() {
    if (
      !job ||
      job.status !== 'failed'
    ) {
      return;
    }

    const confirmed =
      window.confirm(
        'Delete this failed image job? This permanently removes its job data, log file, source images, and generated files.',
      );

    if (!confirmed) {
      return;
    }

    await deleteHistoryItem(
      job.id,
    );
  }

  useEffect(() => {
    loadHistory();
  }, []);

  useEffect(() => {
    if (!image1) {
      setImage1Preview(null);
      return;
    }

    const url =
      URL.createObjectURL(image1);

    setImage1Preview(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [image1]);

  useEffect(() => {
    if (!image2) {
      setImage2Preview(null);
      return;
    }

    const url =
      URL.createObjectURL(image2);

    setImage2Preview(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [image2]);

  useEffect(() => {
    let savedJobId:
      string | null = null;

    try {
      savedJobId =
        localStorage.getItem(
          ACTIVE_JOB_STORAGE_KEY,
        );
    } catch {
      return;
    }

    if (!savedJobId) {
      return;
    }

    let cancelled = false;

    async function restoreJob() {
      try {
        const response =
          await fetch(
            `/api/generate/image/long/${savedJobId}`,
            {
              cache: 'no-store',
            },
          );

        if (
          response.status === 404
        ) {
          localStorage.removeItem(
            ACTIVE_JOB_STORAGE_KEY,
          );

          return;
        }

        if (!response.ok) {
          throw new Error(
            'Failed to restore image job',
          );
        }

        const restoredJob =
          (await response.json()) as
            ImageJobStatusResponse;

        if (!cancelled) {
          setJob(restoredJob);
          setPrompt(
            restoredJob.prompt,
          );

          setEnhancePrompt(
            restoredJob.enhancePrompt ===
            true,
          );

          setEnhanceSecondPrompt(
            restoredJob.enhanceSecondPrompt ===
            true,
          );

          setSecondPrompt(
            restoredJob.secondPrompt ??
            '',
          );

          const restoredKey =
            `${restoredJob.width}x${restoredJob.height}`;

          if (
            IMAGE_RESOLUTIONS.some(
              (item) =>
                item.key ===
                restoredKey,
            )
          ) {
            setResolutionKey(
              restoredKey,
            );
          }
        }

        if (
          restoredJob.status ===
            'completed' ||
          restoredJob.status ===
            'failed' ||
          restoredJob.status ===
            'cancelled'
        ) {
          localStorage.removeItem(
            ACTIVE_JOB_STORAGE_KEY,
          );
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
    if (!job) {
      return;
    }

    if (
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      return;
    }

    const jobId =
      job.id;

    let cancelled = false;

    const timer =
      window.setInterval(
        async () => {
          try {
            const response =
              await fetch(
                `/api/generate/image/long/${jobId}`,
                {
                  cache:
                    'no-store',
                },
              );

            if (!response.ok) {
              throw new Error(
                'Failed to read image job status',
              );
            }

            const updated =
              (await response.json()) as
                ImageJobStatusResponse;

            if (cancelled) {
              return;
            }

            setJob(updated);

            if (
              updated.status ===
                'completed' ||
              updated.status ===
                'failed' ||
              updated.status ===
                'cancelled'
            ) {
              try {
                localStorage.removeItem(
                  ACTIVE_JOB_STORAGE_KEY,
                );
              } catch {
                // Optional.
              }

              if (
                updated.status ===
                'completed'
              ) {
                toast.success(
                  'Image generation complete',
                );
              } else if (
                updated.status ===
                'failed'
              ) {
                toast.error(
                  'Image generation failed',
                );
              }

              await loadHistory();
            }
          } catch (error) {
            console.error(error);
          }
        },
        2000,
      );

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status]);

  return (
    <div className="min-h-[100dvh] bg-gradient-to-b from-slate-50 to-slate-100 px-4 py-10 dark:from-slate-950 dark:to-slate-900 md:px-8">
      <div className="mx-auto w-full max-w-5xl space-y-8">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            router.push('/')
          }
          className="gap-2 px-0 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to NeoAcademy
        </Button>

        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <ImageIcon className="size-5" />
          </div>

          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Generate Image
            </h1>

            <p className="text-sm text-muted-foreground">
              Create a new image, edit an existing image, or combine two images with Flux.
            </p>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card>
            <CardHeader>
              <CardTitle>
                Image description
              </CardTitle>

              <CardDescription>
                Describe the image you want. Add a source image to edit it, or add two images to combine them.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="image-prompt">
                  Prompt 1
                </Label>

                <Textarea
                  id="image-prompt"
                  value={prompt}
                  onChange={(event) =>
                    setPrompt(
                      event.target.value,
                    )
                  }
                  placeholder="A red fox beside a woodland stream, realistic photography, soft morning light..."
                  rows={6}
                  disabled={isActive}
                  className="resize-y"
                />

                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={enhancePrompt}
                    disabled={isActive}
                    onChange={(event) =>
                      setEnhancePrompt(
                        event.target.checked,
                      )
                    }
                    className="mt-0.5 size-4"
                  />

                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">
                      Enhance Prompt 1
                    </span>

                    <span className="block text-xs text-muted-foreground">
                      Add useful visual detail while preserving the original meaning.
                    </span>
                  </span>
                </label>
              </div>

              <div className="space-y-2">
                <Label>
                  Resolution
                </Label>

                <Select
                  value={resolutionKey}
                  onValueChange={
                    setResolutionKey
                  }
                  disabled={isActive}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>

                  <SelectContent>
                    {IMAGE_RESOLUTIONS.map(
                      (item) => (
                        <SelectItem
                          key={item.key}
                          value={item.key}
                        >
                          {item.label}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>
                  Image 1
                </Label>

                <input
                  ref={image1InputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  disabled={isActive}
                  onChange={(event) => {
                    handleImage1(
                      event.target.files?.[0] ??
                      null,
                    );

                    event.target.value =
                      '';
                  }}
                />

                {image1Preview ? (
                  <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-muted">
                    <img
                      src={image1Preview}
                      alt="First source image preview"
                      className="aspect-video w-full object-contain"
                    />

                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      className="absolute right-2 top-2 size-8 rounded-full"
                      disabled={isActive}
                      onClick={() =>
                        handleImage1(null)
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={isActive}
                    onClick={() =>
                      image1InputRef.current?.click()
                    }
                    className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/70 bg-muted/30 text-muted-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ImagePlus className="size-6" />

                    <span className="text-sm">
                      Optional source image
                    </span>
                  </button>
                )}
              </div>

              {image1 && (
                <div className="space-y-4 rounded-xl border border-border/60 p-4">
                  <div className="space-y-2">
                    <Label>
                      Image 2
                    </Label>

                    <input
                      ref={image2InputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      disabled={isActive}
                      onChange={(event) => {
                        handleImage2(
                          event.target.files?.[0] ??
                          null,
                        );

                        event.target.value =
                          '';
                      }}
                    />

                    {image2Preview ? (
                      <div className="relative overflow-hidden rounded-xl border border-border/60 bg-muted">
                        <img
                          src={image2Preview}
                          alt="Second source image preview"
                          className="aspect-video w-full object-contain"
                        />

                        <Button
                          type="button"
                          size="icon"
                          variant="secondary"
                          className="absolute right-2 top-2 size-8 rounded-full"
                          disabled={isActive}
                          onClick={() =>
                            handleImage2(null)
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        disabled={isActive}
                        onClick={() =>
                          image2InputRef.current?.click()
                        }
                      >
                        <ImagePlus className="mr-2 size-4" />
                        Add second image
                      </Button>
                    )}
                  </div>

                  {image2 && (
                    <div className="space-y-2">
                      <Label htmlFor="image-second-prompt">
                        Prompt 2
                      </Label>

                      <Textarea
                        id="image-second-prompt"
                        value={secondPrompt}
                        onChange={(event) =>
                          setSecondPrompt(
                            event.target.value,
                          )
                        }
                        placeholder="Describe how the second image should be incorporated..."
                        rows={4}
                        disabled={isActive}
                        className="resize-y"
                      />

                      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={
                            enhanceSecondPrompt
                          }
                          disabled={isActive}
                          onChange={(event) =>
                            setEnhanceSecondPrompt(
                              event.target.checked,
                            )
                          }
                          className="mt-0.5 size-4"
                        />

                        <span className="space-y-0.5">
                          <span className="block text-sm font-medium">
                            Enhance Prompt 2
                          </span>

                          <span className="block text-xs text-muted-foreground">
                            Enhance the composition instruction independently from Prompt 1.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}
                </div>
              )}

              <Button
                type="button"
                className="w-full"
                size="lg"
                disabled={
                  isActive ||
                  !prompt.trim() ||
                  Boolean(
                    image2 &&
                    !secondPrompt.trim(),
                  )
                }
                onClick={handleGenerate}
              >
                {isActive ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <ImageIcon className="mr-2 size-4" />
                    Generate Image
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>
                  Progress
                </CardTitle>

                <CardDescription>
                  Flux runs locally through NeoAcademy and ComfyUI.
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-4">
                {job || submitting ? (
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-muted-foreground">
                          {statusMessage}
                        </span>

                        <span className="font-mono text-xs">
                          {progress}%
                        </span>
                      </div>

                      <Progress
                        value={progress}
                      />
                    </div>

                    {job && (
                      <p className="text-xs text-muted-foreground">
                        {modeLabel(
                          job.mode,
                        )}{' '}
                        · {job.width} ×{' '}
                        {job.height}
                      </p>
                    )}

                    {job?.status ===
                      'failed' && (
                      <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-medium text-destructive">
                            Job failed
                          </p>

                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={
                                !job.error
                              }
                              onClick={() =>
                                job.error &&
                                copyText(
                                  job.error,
                                  'Error details',
                                )
                              }
                            >
                              <Copy className="mr-2 size-4" />
                              Copy error
                            </Button>

                            <Button
                              type="button"
                              variant="destructive"
                              size="icon"
                              onClick={
                                deleteFailedJob
                              }
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Configure an image and press Generate Image.
                  </p>
                )}
              </CardContent>
            </Card>

            {job?.status ===
              'completed' &&
              job.outputUrl && (
                <Card>
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="size-5 text-green-500" />

                      <CardTitle>
                        Finished image
                      </CardTitle>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-4">
                    <img
                      src={job.outputUrl}
                      alt="Generated image"
                      className="w-full rounded-xl bg-black object-contain"
                    />

                    <div className="space-y-2 rounded-lg border border-border/60 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-medium text-muted-foreground">
                          Prompt 1
                        </span>

                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            copyText(
                              job.prompt,
                              'Prompt 1',
                            )
                          }
                        >
                          <Copy className="mr-2 size-3.5" />
                          Copy
                        </Button>
                      </div>

                      {job.enhancedPrompt && (
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs font-medium text-violet-600 dark:text-violet-400">
                            Enhanced Prompt 1
                          </span>

                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              copyText(
                                job.enhancedPrompt!,
                                'Enhanced Prompt 1',
                              )
                            }
                          >
                            <Copy className="mr-2 size-3.5" />
                            Copy
                          </Button>
                        </div>
                      )}

                      {job.secondPrompt && (
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs font-medium text-muted-foreground">
                            Prompt 2
                          </span>

                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              copyText(
                                job.secondPrompt!,
                                'Prompt 2',
                              )
                            }
                          >
                            <Copy className="mr-2 size-3.5" />
                            Copy
                          </Button>
                        </div>
                      )}

                      {job.enhancedSecondPrompt && (
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs font-medium text-fuchsia-600 dark:text-fuchsia-400">
                            Enhanced Prompt 2
                          </span>

                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              copyText(
                                job.enhancedSecondPrompt!,
                                'Enhanced Prompt 2',
                              )
                            }
                          >
                            <Copy className="mr-2 size-3.5" />
                            Copy
                          </Button>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={resetForm}
                      >
                        New Image
                      </Button>

                      <Button asChild>
                        <a
                          href={job.outputUrl}
                          download={`neoacademy-image-${job.id}.png`}
                        >
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

        {(historyLoading ||
          history.length > 0) && (
          <section className="space-y-5 pt-4">
            <div className="flex items-center gap-4">
              <div className="h-px flex-1 bg-border/50" />

              <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
                <ImageIcon className="size-4" />

                <span>
                  Image History
                </span>

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
                Loading image history...
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
                {history.map(
                  (item) => {
                    const confirmingDelete =
                      pendingHistoryDeleteId ===
                      item.id;

                    return (
                      <div
                        key={item.id}
                        className="group min-w-0"
                      >
                        <div className="relative aspect-square overflow-hidden rounded-2xl bg-black">
                          {item.status ===
                            'completed' &&
                          item.outputUrl ? (
                            <img
                              src={
                                item.outputUrl
                              }
                              alt="Generated image"
                              className="size-full object-cover"
                            />
                          ) : (
                            <div className="flex size-full flex-col items-center justify-center gap-3 bg-destructive/10 px-6 text-center">
                              <AlertCircle className="size-10 text-destructive" />

                              <div>
                                <p className="font-medium text-destructive">
                                  Image generation failed
                                </p>

                                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                                  {item.error ||
                                    'No error details are available.'}
                                </p>
                              </div>
                            </div>
                          )}

                          {!confirmingDelete && (
                            <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                              <Button
                                type="button"
                                size="icon"
                                variant="secondary"
                                className="size-8 rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70 hover:text-white"
                                onClick={() =>
                                  copyText(
                                    item.prompt,
                                    'Prompt 1',
                                  )
                                }
                                title="Copy Prompt 1"
                              >
                                <Copy className="size-4" />
                              </Button>

                              {item.enhancedPrompt && (
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="secondary"
                                  className="size-8 rounded-full bg-violet-600/80 text-white hover:bg-violet-600 hover:text-white"
                                  onClick={() =>
                                    copyText(
                                      item.enhancedPrompt!,
                                      'Enhanced Prompt 1',
                                    )
                                  }
                                  title="Copy enhanced Prompt 1"
                                >
                                  <Copy className="size-4" />
                                </Button>
                              )}

                              {item.secondPrompt && (
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="secondary"
                                  className="size-8 rounded-full bg-blue-600/80 text-white hover:bg-blue-600 hover:text-white"
                                  onClick={() =>
                                    copyText(
                                      item.secondPrompt!,
                                      'Prompt 2',
                                    )
                                  }
                                  title="Copy Prompt 2"
                                >
                                  <Copy className="size-4" />
                                </Button>
                              )}

                              {item.enhancedSecondPrompt && (
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="secondary"
                                  className="size-8 rounded-full bg-fuchsia-600/80 text-white hover:bg-fuchsia-600 hover:text-white"
                                  onClick={() =>
                                    copyText(
                                      item.enhancedSecondPrompt!,
                                      'Enhanced Prompt 2',
                                    )
                                  }
                                  title="Copy enhanced Prompt 2"
                                >
                                  <Copy className="size-4" />
                                </Button>
                              )}

                              {item.status ===
                                'failed' &&
                                item.error && (
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="secondary"
                                    className="size-8 rounded-full bg-red-600/80 text-white hover:bg-red-600 hover:text-white"
                                    onClick={() =>
                                      copyText(
                                        item.error!,
                                        'Error details',
                                      )
                                    }
                                    title="Copy error details"
                                  >
                                    <AlertCircle className="size-4" />
                                  </Button>
                                )}

                              {item.status ===
                                'failed' && (
                                <Button
                                  asChild
                                  type="button"
                                  size="icon"
                                  variant="secondary"
                                  className="size-8 rounded-full bg-amber-600/80 text-white hover:bg-amber-600 hover:text-white"
                                >
                                  <a
                                    href={
                                      item.logUrl
                                    }
                                    target="_blank"
                                    rel="noreferrer"
                                    title="View ComfyUI log"
                                  >
                                    <ImageIcon className="size-4" />
                                  </a>
                                </Button>
                              )}

                              {item.status ===
                                'completed' &&
                                item.outputUrl && (
                                  <Button
                                    asChild
                                    type="button"
                                    size="icon"
                                    variant="secondary"
                                    className="size-8 rounded-full bg-black/50 text-white hover:bg-black/70 hover:text-white"
                                  >
                                    <a
                                      href={
                                        item.outputUrl
                                      }
                                      download={`neoacademy-image-${item.id}.png`}
                                      title="Download image"
                                    >
                                      <Download className="size-4" />
                                    </a>
                                  </Button>
                                )}

                              <Button
                                type="button"
                                size="icon"
                                variant="secondary"
                                className="size-8 rounded-full bg-black/50 text-white hover:bg-destructive hover:text-white"
                                onClick={() =>
                                  setPendingHistoryDeleteId(
                                    item.id,
                                  )
                                }
                                title="Delete image job"
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          )}

                          {confirmingDelete && (
                            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60 backdrop-blur-[6px]">
                              <span className="text-sm font-medium text-white">
                                Delete this image?
                              </span>

                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  className="rounded-lg bg-white/15 px-3.5 py-1.5 text-xs font-medium text-white/90 hover:bg-white/25"
                                  onClick={() =>
                                    setPendingHistoryDeleteId(
                                      null,
                                    )
                                  }
                                >
                                  Cancel
                                </button>

                                <button
                                  type="button"
                                  className="rounded-lg bg-red-500/90 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-red-500"
                                  onClick={() =>
                                    deleteHistoryItem(
                                      item.id,
                                    )
                                  }
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="mt-2.5 min-w-0 px-1">
                          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span
                              className={
                                item.status ===
                                'failed'
                                  ? 'rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-600 dark:bg-red-900/30 dark:text-red-400'
                                  : 'rounded-full bg-violet-100 px-2 py-0.5 font-medium text-violet-600 dark:bg-violet-900/30 dark:text-violet-400'
                              }
                            >
                              {item.status ===
                              'failed'
                                ? 'Failed'
                                : modeLabel(
                                    item.mode,
                                  )}
                            </span>

                            <span>
                              {item.width} ×{' '}
                              {item.height}
                            </span>

                            <span>
                              {formatHistoryDate(
                                item.createdAt,
                              )}
                            </span>
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
                  },
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}