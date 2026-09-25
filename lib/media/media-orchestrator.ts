/**
 * Media Generation Orchestrator
 *
 * Dispatches media generation API calls for all mediaGenerations across outlines.
 * Runs entirely on the frontend — calls /api/generate/image and /api/generate/video,
 * fetches result blobs, stores in IndexedDB, and updates the Zustand store.
 */

import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { db, mediaFileKey } from '@/lib/utils/database';
import type { SceneOutline } from '@/lib/types/generation';
import type { MediaGenerationRequest } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { logGenerationProgress } from '@/lib/generation/progress-log';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

const log = createLogger('MediaOrchestrator');

/** Error with a structured errorCode from the API */
class MediaApiError extends Error {
  errorCode?: string;
  constructor(message: string, errorCode?: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

/**
 * Launch media generation for all mediaGenerations declared in outlines.
 * Runs as a dedicated media phase after class content generation.
 */
export async function generateMediaForOutlines(
  outlines: SceneOutline[],
  stageId: string,
  abortSignal?: AbortSignal,
  mediaType?: 'image' | 'video',
): Promise<void> {
  const settings = useSettingsStore.getState();
  const store = useMediaGenerationStore.getState();

  // Collect all media requests
  const allRequests: MediaGenerationRequest[] = [];
  for (const outline of outlines) {
    if (!outline.mediaGenerations) continue;
    for (const mg of outline.mediaGenerations) {
      // Optional phase filter — allows images and videos to run under
      // different heavyweight local model lifecycles.
      if (mediaType && mg.type !== mediaType) continue;

      // Filter by enabled flags
      if (mg.type === 'image' && !settings.imageGenerationEnabled) continue;
      if (mg.type === 'video' && !settings.videoGenerationEnabled) continue;
      // Skip already completed or permanently failed (restored from DB)
      const existing = store.getTask(mg.elementId);
      if (existing?.status === 'done' || existing?.status === 'failed') continue;
      allRequests.push(mg);
    }
  }

  if (allRequests.length === 0) return;

  // Enqueue all as pending
  useMediaGenerationStore.getState().enqueueTasks(stageId, allRequests);

  const phaseLabel = mediaType === 'image' ? 'Image' : mediaType === 'video' ? 'Video' : 'Media';

  logGenerationProgress(
    `[MediaOrchestrator] ${phaseLabel} phase: ${allRequests.length} item${allRequests.length === 1 ? '' : 's'} to generate`,
  );

  // Process requests serially — image/video APIs have limited concurrency
  for (let index = 0; index < allRequests.length; index++) {
    if (abortSignal?.aborted) break;

    const req = allRequests[index];

    logGenerationProgress(
      `[MediaOrchestrator] Generating ${req.type} ${index + 1} of ${allRequests.length}`,
    );

    await generateSingleMedia(req, stageId, abortSignal);

    logGenerationProgress(
      `[MediaOrchestrator] Completed ${req.type} ${index + 1} of ${allRequests.length}`,
    );
  }

  if (!abortSignal?.aborted) {
    logGenerationProgress(
      `[MediaOrchestrator] ${phaseLabel} phase complete: ${allRequests.length} of ${allRequests.length}`,
    );
  }
}

/**
 * Retry a single failed media task.
 */
export async function retryMediaTask(elementId: string): Promise<void> {
  const store = useMediaGenerationStore.getState();
  const task = store.getTask(elementId);
  if (!task || task.status !== 'failed') return;

  // Check if the corresponding generation type is still enabled in global settings
  const settings = useSettingsStore.getState();
  if (task.type === 'image' && !settings.imageGenerationEnabled) {
    store.markFailed(elementId, 'Generation disabled', 'GENERATION_DISABLED');
    return;
  }
  if (task.type === 'video' && !settings.videoGenerationEnabled) {
    store.markFailed(elementId, 'Generation disabled', 'GENERATION_DISABLED');
    return;
  }

  // Remove persisted failure record from DB so a fresh result can be written
  const dbKey = mediaFileKey(task.stageId, elementId);
  await db.mediaFiles.delete(dbKey).catch(() => {});

  store.markPendingForRetry(elementId);
  await generateSingleMedia(
    {
      type: task.type,
      prompt: task.prompt,
      elementId: task.elementId,
      durationSeconds: task.params.duration,
      aspectRatio: task.params.aspectRatio as MediaGenerationRequest['aspectRatio'],
      style: task.params.style,
      enhancePrompt: task.params.enhancePrompt === true,
    },
    task.stageId,
  );
}

// ==================== Internal ====================

async function generateSingleMedia(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const store = useMediaGenerationStore.getState();
  store.markGenerating(req.elementId);

  try {
    let resultUrl: string;
    let posterUrl: string | undefined;
    let mimeType: string;

    if (req.type === 'image') {
      const result = await callImageApi(req, stageId, abortSignal);
      resultUrl = result.url;
      mimeType = 'image/png';
    } else {
      const result = await callVideoApi(req, stageId, abortSignal);
      resultUrl = result.url;
      posterUrl = result.poster;
      mimeType = 'video/mp4';
    }

    if (abortSignal?.aborted) return;

    // Fetch blob from URL
    const blob = await fetchAsBlob(resultUrl);
    const posterBlob = posterUrl ? await fetchAsBlob(posterUrl).catch(() => undefined) : undefined;

    // Store in IndexedDB
    await db.mediaFiles.put({
      id: mediaFileKey(stageId, req.elementId),
      stageId,
      type: req.type,
      blob,
      mimeType,
      size: blob.size,
      poster: posterBlob,
      prompt: req.prompt,
      params: JSON.stringify({
        duration: req.durationSeconds,
        aspectRatio: req.aspectRatio,
        style: req.style,
        enhancePrompt: req.enhancePrompt === true,
      }),
      createdAt: Date.now(),
    });

    // Update store with object URL
    const objectUrl = URL.createObjectURL(blob);
    const posterObjectUrl = posterBlob ? URL.createObjectURL(posterBlob) : undefined;
    useMediaGenerationStore.getState().markDone(req.elementId, objectUrl, posterObjectUrl);
  } catch (err) {
    if (abortSignal?.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof MediaApiError ? err.errorCode : undefined;
    log.error(`Failed ${req.elementId}:`, message);
    useMediaGenerationStore.getState().markFailed(req.elementId, message, errorCode);

    // Persist non-retryable failures to IndexedDB so they survive page refresh
    if (errorCode) {
      await db.mediaFiles
        .put({
          id: mediaFileKey(stageId, req.elementId),
          stageId,
          type: req.type,
          blob: new Blob(), // empty placeholder
          mimeType: req.type === 'image' ? 'image/png' : 'video/mp4',
          size: 0,
          prompt: req.prompt,
          params: JSON.stringify({
            duration: req.durationSeconds,
            aspectRatio: req.aspectRatio,
            style: req.style,
          }),
          error: message,
          errorCode,
          createdAt: Date.now(),
        })
        .catch(() => {}); // best-effort
    }
  }
}

type LongImageJobStatus =
  | 'queued'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface LongImageJobStatusResponse {
  id: string;
  status: LongImageJobStatus;
  outputUrl?: string;
  error?: string;
}

function getClassroomImageDimensions(
  aspectRatio: MediaGenerationRequest['aspectRatio'],
): { width: number; height: number } {
  switch (aspectRatio) {
    case '4:3':
      return { width: 1024, height: 768 };

    case '1:1':
      return { width: 1024, height: 1024 };

    case '9:16':
      return { width: 720, height: 1280 };

    case '16:9':
    default:
      return { width: 1280, height: 720 };
  }
}

async function waitForLongImageJob(
  jobId: string,
  abortSignal?: AbortSignal,
): Promise<LongImageJobStatusResponse> {
  while (true) {
    if (abortSignal?.aborted) {
      throw new DOMException(
        'Image generation aborted',
        'AbortError',
      );
    }

    const response = await fetch(
      `/api/generate/image/long/${jobId}`,
      {
        cache: 'no-store',
        signal: abortSignal,
      },
    );

    if (!response.ok) {
      const data =
        await response.json().catch(() => ({}));

      throw new MediaApiError(
        data.error ||
          `Long image status API returned ${response.status}`,
        data.errorCode,
      );
    }

    const job =
      (await response.json()) as LongImageJobStatusResponse;

    if (job.status === 'completed') {
      if (!job.outputUrl) {
        throw new Error(
          'Completed image job has no output URL',
        );
      }

      return job;
    }

    if (job.status === 'failed') {
      throw new Error(
        job.error || 'Image generation failed',
      );
    }

    if (job.status === 'cancelled') {
      throw new Error(
        job.error || 'Image generation cancelled',
      );
    }

    await new Promise<void>((resolve, reject) => {
      const timer =
        window.setTimeout(resolve, 2000);

      if (abortSignal) {
        abortSignal.addEventListener(
          'abort',
          () => {
            window.clearTimeout(timer);

            reject(
              new DOMException(
                'Image generation aborted',
                'AbortError',
              ),
            );
          },
          { once: true },
        );
      }
    });
  }
}

async function callLongImageApi(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<{ url: string }> {
  const dimensions =
    getClassroomImageDimensions(
      req.aspectRatio,
    );

  const formData =
    new FormData();

  formData.append(
    'prompt',
    req.prompt,
  );

  formData.append(
    'width',
    String(dimensions.width),
  );

  formData.append(
    'height',
    String(dimensions.height),
  );

  formData.append(
    'stageId',
    stageId,
  );

  formData.append(
    'elementId',
    req.elementId,
  );

  formData.append(
    'enhancePrompt',
    req.enhancePrompt === true
      ? 'true'
      : 'false',
  );

  const response = await fetch(
    '/api/generate/image/long',
    {
      method: 'POST',
      body: formData,
      signal: abortSignal,
    },
  );

  const result =
    await response
      .json()
      .catch(() => ({}));

  if (
    !response.ok ||
    !result.success
  ) {
    throw new MediaApiError(
      result.error ||
        result.message ||
        `Long image API returned ${response.status}`,
      result.errorCode,
    );
  }

  const jobId =
    result.jobId as string | undefined;

  if (!jobId) {
    throw new Error(
      'Long image API did not return a job ID',
    );
  }

  const completed =
    await waitForLongImageJob(
      jobId,
      abortSignal,
    );

  return {
    url: completed.outputUrl!,
  };
}

async function callImageApi(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<{ url: string }> {
  const settings =
    useSettingsStore.getState();

  if (settings.imageProviderId === 'comfyui') {
    return callLongImageApi(
      req,
      stageId,
      abortSignal,
    );
  }

  const providerConfig =
    settings.imageProvidersConfig?.[
      settings.imageProviderId
    ];

  const response = await fetch(
    '/api/generate/image',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-image-provider':
          settings.imageProviderId || '',
        'x-image-model':
          settings.imageModelId || '',
        'x-api-key':
          providerConfig?.apiKey || '',
        'x-base-url':
          providerConfig?.baseUrl || '',
      },
      body: JSON.stringify({
        prompt: req.prompt,
        aspectRatio: req.aspectRatio,
        style: req.style,
      }),
      signal: abortSignal,
    },
  );

  if (!response.ok) {
    const data =
      await response.json().catch(() => ({}));

    throw new MediaApiError(
      data.error ||
        `Image API returned ${response.status}`,
      data.errorCode,
    );
  }

  const data =
    await response.json();

  if (!data.success) {
    throw new MediaApiError(
      data.error || 'Image generation failed',
      data.errorCode,
    );
  }

  const url =
    data.result?.url ||
    (
      data.result?.base64
        ? `data:image/png;base64,${data.result.base64}`
        : ''
    );

  if (!url) {
    throw new Error(
      'No image URL in response',
    );
  }

  return { url };
}

type LongVideoJobStatus =
  | 'queued'
  | 'planning'
  | 'generating'
  | 'assembling'
  | 'completed'
  | 'failed';

interface LongVideoJobStatusResponse {
  id: string;
  status: LongVideoJobStatus;
  outputUrl?: string;
  error?: string;
}

function getClassroomVideoDuration(req: MediaGenerationRequest): number {
  const duration = req.durationSeconds ?? 15;

  if (!Number.isFinite(duration)) {
    return 15;
  }

  const rounded = Math.round(duration / 5) * 5;

  return Math.min(30, Math.max(5, rounded));
}

async function waitForLongVideoJob(
  jobId: string,
  abortSignal?: AbortSignal,
): Promise<LongVideoJobStatusResponse> {
  while (true) {
    if (abortSignal?.aborted) {
      throw new DOMException('Video generation aborted', 'AbortError');
    }

    const response = await fetch(`/api/generate/video/long/${jobId}`, {
      cache: 'no-store',
      signal: abortSignal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));

      throw new MediaApiError(
        data.error || `Long video status API returned ${response.status}`,
        data.errorCode,
      );
    }

    const job = (await response.json()) as LongVideoJobStatusResponse;

    if (job.status === 'completed') {
      if (!job.outputUrl) {
        throw new Error('Completed long video job has no output URL');
      }

      return job;
    }

    if (job.status === 'failed') {
      throw new Error(job.error || 'Long video generation failed');
    }

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, 2000);

      if (abortSignal) {
        abortSignal.addEventListener(
          'abort',
          () => {
            window.clearTimeout(timer);
            reject(new DOMException('Video generation aborted', 'AbortError'));
          },
          { once: true },
        );
      }
    });
  }
}

async function callLongVideoApi(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<{ url: string; poster?: string }> {
  const modelConfig = getCurrentModelConfig();
  const durationSeconds = getClassroomVideoDuration(req);

  const response = await fetch('/api/generate/video/long', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-model': modelConfig.modelString,
      'x-api-key': modelConfig.apiKey,
      'x-base-url': modelConfig.baseUrl,
      'x-provider-type': modelConfig.providerType || '',
      'x-requires-api-key': modelConfig.requiresApiKey ? 'true' : 'false',
    },
    body: JSON.stringify({
      prompt: req.prompt,
      targetDurationSeconds: durationSeconds,
      stageId,
      elementId: req.elementId,
    }),
    signal: abortSignal,
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.success) {
    throw new MediaApiError(
      result.error || result.message || `Long video API returned ${response.status}`,
      result.errorCode,
    );
  }

  const jobId = result.jobId as string | undefined;

  if (!jobId) {
    throw new Error('Long video API did not return a job ID');
  }

  const completedJob = await waitForLongVideoJob(jobId, abortSignal);

  return {
    url: completedJob.outputUrl!,
  };
}

async function callVideoApi(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<{ url: string; poster?: string }> {
  const settings = useSettingsStore.getState();
  const providerConfig = settings.videoProvidersConfig?.[settings.videoProviderId];

  if (settings.videoProviderId === 'comfyui') {
    return callLongVideoApi(req, stageId, abortSignal);
  }

  const response = await fetch('/api/generate/video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-video-provider': settings.videoProviderId || '',
      'x-video-model': settings.videoModelId || '',
      'x-api-key': providerConfig?.apiKey || '',
      'x-base-url': providerConfig?.baseUrl || '',
    },
    body: JSON.stringify({
      prompt: req.prompt,
      aspectRatio: req.aspectRatio,
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new MediaApiError(data.error || `Video API returned ${response.status}`, data.errorCode);
  }

  const data = await response.json();
  if (!data.success)
    throw new MediaApiError(data.error || 'Video generation failed', data.errorCode);

  const url = data.result?.url;
  if (!url) throw new Error('No video URL in response');
  return { url, poster: data.result?.poster };
}

async function fetchAsBlob(url: string): Promise<Blob> {
  // For data URLs, convert directly
  if (url.startsWith('data:')) {
    const res = await fetch(url);
    return res.blob();
  }
  // For remote URLs, proxy through our server to bypass CORS restrictions
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await fetch('/api/proxy-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Proxy fetch failed: ${res.status}`);
    }
    return res.blob();
  }
  // Relative URLs (shouldn't happen, but handle gracefully)
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch blob: ${res.status}`);
  return res.blob();
}
