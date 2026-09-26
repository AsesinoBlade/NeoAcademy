import { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  parseLocalMinerUBatch,
  type LocalMinerUInput,
} from '@/lib/server/local-mineru';

export const runtime = 'nodejs';

const log = createLogger('MinerU Batch');

const MAX_DOCUMENTS = 20;

export async function POST(
  req: NextRequest,
) {
  try {
    const contentType =
      req.headers.get('content-type') || '';

    if (
      !contentType.includes(
        'multipart/form-data',
      )
    ) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'Expected multipart/form-data',
      );
    }

    const formData =
      await req.formData();

    const candidates = [
      ...formData.getAll('pdfs'),
      ...formData.getAll('pdf'),
    ];

    const files =
      candidates.filter(
        (entry): entry is File =>
          entry instanceof File,
      );

    if (files.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'No PDF files provided',
      );
    }

    if (
      files.length >
      MAX_DOCUMENTS
    ) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Maximum ${MAX_DOCUMENTS} documents per MinerU batch`,
      );
    }

    const inputs: LocalMinerUInput[] =
      [];

    for (const file of files) {
      if (
        file.size === 0
      ) {
        return apiError(
          'INVALID_REQUEST',
          400,
          `PDF is empty: ${file.name}`,
        );
      }

      const buffer =
        Buffer.from(
          await file.arrayBuffer(),
        );

      inputs.push({
        fileName:
          file.name ||
          'document.pdf',
        buffer,
      });
    }

    log.info(
      `[MinerU] Batch request: ${inputs.length} document(s)`,
    );

    const startedAt =
      Date.now();

    const results =
      await parseLocalMinerUBatch(
        inputs,
        req.signal,
      );

    const processingTime =
      Date.now() -
      startedAt;

    const data =
      results.map(
        (result, index) => ({
          fileName:
            result.fileName,

          data: {
            ...result.data,

            metadata: {
              pageCount:
                result.data.metadata
                  ?.pageCount ?? 0,

              ...result.data.metadata,

              fileName:
                result.fileName,

              fileSize:
                inputs[index]
                  ?.buffer.length,

              processingTime,
            },
          },
        }),
      );

    log.info(
      `[MinerU] Batch complete: ` +
        `${data.length} document(s), ` +
        `${processingTime}ms`,
    );

    return apiSuccess({
      data,
    });
  } catch (error) {
    log.error(
      'Local MinerU batch parse failed:',
      error,
    );

    return apiError(
      'PARSE_FAILED',
      500,
      error instanceof Error
        ? error.message
        : 'Unknown MinerU error',
    );
  }
}