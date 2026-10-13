/**
 * Generate the next missing picture for an ebook (cover first, then figures).
 *
 * POST /api/generate/book-image  { bookId, dryRun? }
 *   headers: x-image-provider, x-image-model, x-api-key, x-base-url
 *
 * One image per call so the client can pause between images. Returns
 * { generated?: id, remaining }. Images that fail twice are recorded in
 * images/failed.json and skipped (the figure is simply left out of the PDF).
 */
import { type NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveImageApiKey, resolveImageBaseUrl } from '@/lib/server/provider-config';
import { IMAGE_PROVIDERS, aspectRatioToDimensions, generateImage } from '@/lib/media/image-providers';
import type { ImageProviderId } from '@/lib/media/types';
import type { ComfyUiImageGenerationResult } from '@/lib/media/adapters/comfyui-adapter';
import { deleteLocalComfyUiAsset } from '@/lib/server/local-comfyui-media';
import { extractImageSpecs, type ImageSpec } from '@/lib/book/figures';
import {
  fileExists,
  imagesDir,
  listSectionRefs,
  listWrittenSectionIds,
  readBook,
  readSection,
} from '@/lib/book/storage';

const log = createLogger('Book Image API');

export const runtime = 'nodejs';
export const maxDuration = 600;

interface FailedRecord {
  [imageId: string]: { attempts: number; error: string };
}

async function readFailed(bookId: string): Promise<FailedRecord> {
  try {
    return JSON.parse(await fs.readFile(path.join(imagesDir(bookId), 'failed.json'), 'utf-8'));
  } catch {
    return {};
  }
}

async function pendingImages(bookId: string): Promise<ImageSpec[]> {
  const book = await readBook(bookId);
  if (!book) return [];

  const failed = await readFailed(bookId);
  const isDone = async (id: string) =>
    (failed[id]?.attempts ?? 0) >= 2 || (await fileExists(path.join(imagesDir(bookId), `${id}.png`)));

  const specs: ImageSpec[] = [];
  if (book.coverImagePrompt) {
    specs.push({ id: 'cover', prompt: book.coverImagePrompt, aspect: '16:9' });
  }
  const written = await listWrittenSectionIds(bookId);
  for (const ref of listSectionRefs(book.outline)) {
    if (!written.has(ref.id)) continue;
    specs.push(...extractImageSpecs((await readSection(bookId, ref.id)) ?? ''));
  }

  const pending: ImageSpec[] = [];
  for (const spec of specs) if (!(await isDone(spec.id))) pending.push(spec);
  return pending;
}

export async function POST(request: NextRequest) {
  try {
    const { bookId, dryRun } = (await request.json()) as { bookId: string; dryRun?: boolean };
    if (!bookId) return apiError('MISSING_REQUIRED_FIELD', 400, 'bookId is required');

    const pending = await pendingImages(bookId);
    // dryRun: just report how many pictures are still missing.
    if (pending.length === 0 || dryRun) return apiSuccess({ remaining: pending.length });

    const spec = pending[0];
    const providerId = (request.headers.get('x-image-provider') || 'comfyui') as ImageProviderId;
    const provider = IMAGE_PROVIDERS[providerId];
    if (!provider) return apiError('INVALID_REQUEST', 400, `Unsupported image provider: ${providerId}`);

    const clientBaseUrl = request.headers.get('x-base-url') || undefined;
    const apiKey = clientBaseUrl
      ? request.headers.get('x-api-key') || ''
      : resolveImageApiKey(providerId, request.headers.get('x-api-key') || undefined);
    const baseUrl = clientBaseUrl || resolveImageBaseUrl(providerId, undefined);
    const model = request.headers.get('x-image-model') || undefined;
    const { width, height } = aspectRatioToDimensions(spec.aspect || '16:9');

    log.info(`Generating ${spec.id} (${pending.length} pending): "${spec.prompt.slice(0, 80)}"`);

    try {
      const result = await generateImage(
        { providerId, apiKey, baseUrl, model },
        {
          prompt: spec.prompt,
          negativePrompt: 'text, letters, watermark, logo, caption, blurry, distorted',
          width,
          height,
        },
      );

      let bytes: Buffer;
      if (result.base64) {
        bytes = Buffer.from(result.base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      } else if (result.url) {
        const url = result.url.startsWith('/')
          ? new URL(result.url, request.nextUrl.origin).href
          : result.url;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Image download failed (${response.status})`);
        bytes = Buffer.from(await response.arrayBuffer());
      } else {
        throw new Error('Image provider returned no image data');
      }

      // Normalise to PNG so the renderer can rely on <id>.png.
      const sharp = (await import('sharp')).default;
      await fs.mkdir(imagesDir(bookId), { recursive: true });
      await sharp(bytes).png().toFile(path.join(imagesDir(bookId), `${spec.id}.png`));

      if (providerId === 'comfyui') {
        const asset = (result as ComfyUiImageGenerationResult).comfyUiAsset;
        if (asset) {
          await deleteLocalComfyUiAsset(
            baseUrl || process.env.IMAGE_COMFYUI_BASE_URL || 'http://127.0.0.1:3100',
            asset,
          ).catch(() => undefined);
        }
      }

      return apiSuccess({ generated: spec.id, remaining: pending.length - 1 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await readFailed(bookId);
      failed[spec.id] = { attempts: (failed[spec.id]?.attempts ?? 0) + 1, error: message };
      await fs.mkdir(imagesDir(bookId), { recursive: true });
      await fs.writeFile(path.join(imagesDir(bookId), 'failed.json'), JSON.stringify(failed, null, 2));
      log.warn(`Image ${spec.id} failed (attempt ${failed[spec.id].attempts}): ${message}`);
      const remaining = (await pendingImages(bookId)).length;
      return apiSuccess({ failed: spec.id, error: message, remaining });
    }
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
