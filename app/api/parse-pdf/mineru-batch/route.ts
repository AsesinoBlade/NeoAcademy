import { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import type {
  ParsedPdfContent,
} from '@/lib/types/pdf';
import {
  apiError,
  apiSuccess,
} from '@/lib/server/api-response';
import {
  parseLocalMinerUBatch,
  type LocalMinerUInput,
} from '@/lib/server/local-mineru';
import {
  analyzeImagesWithLocalVision,
  formatVisualAnalysisForSource,
  type LocalVisionInput,
  type LocalVisualAnalysis,
} from '@/lib/server/local-vision';

export const runtime = 'nodejs';

const log =
  createLogger('Source Pipeline');

const MAX_SOURCES = 20;

interface PreparedSource {
  originalIndex: number;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  isImage: boolean;
}

interface SourceResult {
  fileName: string;
  data: ParsedPdfContent;
}

function inferMimeType(
  file: File,
): string {
  if (file.type) {
    return file.type;
  }

  const lower =
    file.name.toLowerCase();

  if (
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg')
  ) {
    return 'image/jpeg';
  }

  if (
    lower.endsWith('.png')
  ) {
    return 'image/png';
  }

  if (
    lower.endsWith('.webp')
  ) {
    return 'image/webp';
  }

  if (
    lower.endsWith('.pdf')
  ) {
    return 'application/pdf';
  }

  return 'application/octet-stream';
}

function isSupportedImage(
  mimeType: string,
  fileName: string,
): boolean {
  if (
    mimeType === 'image/jpeg' ||
    mimeType === 'image/png' ||
    mimeType === 'image/webp'
  ) {
    return true;
  }

  return /\.(jpe?g|png|webp)$/i.test(
    fileName,
  );
}

function isSupportedPdf(
  mimeType: string,
  fileName: string,
): boolean {
  return (
    mimeType === 'application/pdf' ||
    fileName.toLowerCase()
      .endsWith('.pdf')
  );
}

function createImageSourceResult(
  source: PreparedSource,
): ParsedPdfContent {
  const src =
    `data:${source.mimeType};base64,` +
    source.buffer.toString('base64');

  return {
    text: '',
    images: [],
    layout: [
      {
        page: 1,
        type: 'image',
        content: '',
      },
    ],
    metadata: {
      fileName:
        source.fileName,
      fileSize:
        source.buffer.length,
      pageCount: 1,
      parser: 'image-source',
      pdfImages: [
        {
          id: 'image_1',
          src,
          pageNumber: 1,
          description:
            'Uploaded source image',
        },
      ],
    },
  };
}

function appendVisualAnalysis(
  parsed: ParsedPdfContent,
  analyses: Array<{
    imageIndex: number;
    analysis: LocalVisualAnalysis;
  }>,
): void {
  if (
    analyses.length === 0
  ) {
    return;
  }

  const blocks =
    analyses.map(
      ({
        imageIndex,
        analysis,
      }) => {
        const image =
          parsed.metadata
            ?.pdfImages?.[
              imageIndex
            ];

        const location =
          image?.pageNumber
            ? `page ${image.pageNumber}`
            : 'source image';

        const formatted =
          formatVisualAnalysisForSource(
            analysis,
          );

        if (image) {
          image.description =
            formatted;

          image.visualRegions =
            analysis.visualRegions;
        }

        return (
          `--- VISUAL ${imageIndex + 1} (${location}) ---\n` +
          formatted
        );
      },
    );

  const visualText =
    [
      '===== VISUAL SOURCE ANALYSIS =====',
      ...blocks,
    ].join('\n\n');

  parsed.text =
    parsed.text.trim()
      ? `${parsed.text.trim()}\n\n${visualText}`
      : visualText;

  if (parsed.metadata) {
    parsed.metadata.visualAnalyses =
      analyses.map(
        ({
          imageIndex,
          analysis,
        }) => ({
          imageIndex,
          ...analysis,
        }),
      );
  }
}

export async function POST(
  req: NextRequest,
) {
  try {
    const contentType =
      req.headers.get(
        'content-type',
      ) || '';

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
      ...formData.getAll('sources'),
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
        'No source files provided',
      );
    }

    if (
      files.length >
      MAX_SOURCES
    ) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Maximum ${MAX_SOURCES} sources per batch`,
      );
    }

    const prepared:
      PreparedSource[] = [];

    for (
      let index = 0;
      index < files.length;
      index++
    ) {
      const file =
        files[index];

      if (file.size === 0) {
        return apiError(
          'INVALID_REQUEST',
          400,
          `Source file is empty: ${file.name}`,
        );
      }

      const mimeType =
        inferMimeType(file);

      const image =
        isSupportedImage(
          mimeType,
          file.name,
        );

      const pdf =
        isSupportedPdf(
          mimeType,
          file.name,
        );

      if (
        !image &&
        !pdf
      ) {
        return apiError(
          'INVALID_REQUEST',
          400,
          `Unsupported source type: ${file.name}`,
        );
      }

      prepared.push({
        originalIndex: index,
        fileName:
          file.name ||
          `source_${index + 1}`,
        mimeType,
        buffer:
          Buffer.from(
            await file.arrayBuffer(),
          ),
        isImage: image,
      });
    }

    const startedAt =
      Date.now();

    const resultSlots:
      Array<
        SourceResult | undefined
      > =
      new Array(
        prepared.length,
      );

    // ----------------------------------------------------------
    // Phase 1: PDFs -> MinerU
    //
    // parseLocalMinerUBatch() clears resident Ollama models
    // before it spawns MinerU. The child process has fully exited
    // before this call resolves.
    // ----------------------------------------------------------

    const documentSources =
      prepared.filter(
        (source) =>
          !source.isImage,
      );

    if (
      documentSources.length > 0
    ) {
      log.info(
        `[Pipeline] MinerU phase: ${documentSources.length} document(s)`,
      );

      const mineruInputs:
        LocalMinerUInput[] =
        documentSources.map(
          (source) => ({
            fileName:
              source.fileName,
            buffer:
              source.buffer,
          }),
        );

      const mineruResults =
        await parseLocalMinerUBatch(
          mineruInputs,
          req.signal,
        );

      if (
        mineruResults.length !==
        documentSources.length
      ) {
        throw new Error(
          'MinerU result count did not match document input count',
        );
      }

      for (
        let index = 0;
        index <
        documentSources.length;
        index++
      ) {
        const source =
          documentSources[index];

        resultSlots[
          source.originalIndex
        ] = {
          fileName:
            source.fileName,
          data:
            mineruResults[index]
              .data,
        };
      }

      log.info(
        '[Pipeline] MinerU phase complete; MinerU process has exited',
      );
    } else {
      log.info(
        '[Pipeline] MinerU phase skipped: no document sources',
      );
    }

    // ----------------------------------------------------------
    // Standalone images bypass MinerU entirely.
    // ----------------------------------------------------------

    for (
      const source of prepared
    ) {
      if (
        !source.isImage
      ) {
        continue;
      }

      resultSlots[
        source.originalIndex
      ] = {
        fileName:
          source.fileName,
        data:
          createImageSourceResult(
            source,
          ),
      };
    }

    const completedResults =
      resultSlots.map(
        (
          result,
          index,
        ) => {
          if (!result) {
            throw new Error(
              `Missing parsed result for source ${index + 1}`,
            );
          }

          return result;
        },
      );

    // ----------------------------------------------------------
    // Phase 2: all image assets -> Qwen3-VL
    //
    // This includes:
    //   - directly uploaded images
    //   - images/charts/tables extracted by MinerU
    //
    // One vision model remains resident across the batch and is
    // unloaded before this phase returns.
    // ----------------------------------------------------------

    const visionInputs:
      LocalVisionInput[] = [];

    const visionLocations:
      Array<{
        key: string;
        resultIndex: number;
        imageIndex: number;
      }> = [];

    for (
      let resultIndex = 0;
      resultIndex <
      completedResults.length;
      resultIndex++
    ) {
      const result =
        completedResults[
          resultIndex
        ];

      const sourceImages =
        result.data.metadata
          ?.pdfImages ?? [];

      for (
        let imageIndex = 0;
        imageIndex <
        sourceImages.length;
        imageIndex++
      ) {
        const image =
          sourceImages[
            imageIndex
          ];

        if (!image.src) {
          continue;
        }

        const key =
          `source_${resultIndex}_image_${imageIndex}`;

        visionInputs.push({
          key,
          sourceFileName:
            result.fileName,
          imageId:
            image.id,
          src:
            image.src,
          pageNumber:
            image.pageNumber,
        });

        visionLocations.push({
          key,
          resultIndex,
          imageIndex,
        });
      }
    }

    if (
      visionInputs.length > 0
    ) {
      log.info(
        `[Pipeline] Vision phase: ${visionInputs.length} image(s)`,
      );

      const visionResults =
        await analyzeImagesWithLocalVision(
          visionInputs,
          req.signal,
        );

      const analysesBySource =
        new Map<
          number,
          Array<{
            imageIndex: number;
            analysis:
              LocalVisualAnalysis;
          }>
        >();

      for (
        const location of
        visionLocations
      ) {
        const analysis =
          visionResults.get(
            location.key,
          );

        if (!analysis) {
          throw new Error(
            `Missing visual analysis for ${location.key}`,
          );
        }

        const list =
          analysesBySource.get(
            location.resultIndex,
          ) ?? [];

        list.push({
          imageIndex:
            location.imageIndex,
          analysis,
        });

        analysesBySource.set(
          location.resultIndex,
          list,
        );
      }

      for (
        const [
          resultIndex,
          analyses,
        ] of analysesBySource
      ) {
        appendVisualAnalysis(
          completedResults[
            resultIndex
          ].data,
          analyses,
        );
      }

      log.info(
        '[Pipeline] Vision phase complete; vision model unloaded',
      );
    } else {
      log.info(
        '[Pipeline] Vision phase skipped: no images',
      );
    }

    const processingTime =
      Date.now() -
      startedAt;

    // ----------------------------------------------------------
    // Preserve existing response shape so generation-preview
    // requires no behavioral rewrite.
    // ----------------------------------------------------------

    const data =
      completedResults.map(
        (
          result,
          index,
        ) => ({
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
                prepared[index]
                  .buffer.length,

              processingTime,
            },
          },
        }),
      );

    log.info(
      `[Pipeline] Source preparation complete: ` +
        `${data.length} source(s), ` +
        `${processingTime}ms`,
    );

    return apiSuccess({
      data,
    });
  } catch (error) {
    log.error(
      'Local source preparation failed:',
      error,
    );

    return apiError(
      'PARSE_FAILED',
      500,
      error instanceof Error
        ? error.message
        : 'Unknown source preparation error',
    );
  }
}