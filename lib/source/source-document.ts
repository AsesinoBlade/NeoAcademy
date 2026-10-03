import type { ParsedPdfContent } from '@/lib/types/pdf';
import type {
  SourceAsset,
  SourceDocument,
  SourceSection,
} from '@/lib/types/source-document';

function inferSourceDocumentType(
  fileName: string,
  mimeType: string,
): SourceDocument['sourceType'] {
  const lowerName = fileName.toLowerCase();
  const lowerMime = mimeType.toLowerCase();

  if (
    lowerMime === 'application/pdf' ||
    lowerName.endsWith('.pdf')
  ) {
    return 'pdf';
  }

  if (lowerMime.startsWith('image/')) {
    return 'image';
  }

  if (
    lowerMime === 'application/json' ||
    lowerMime === 'text/json' ||
    lowerName.endsWith('.json')
  ) {
    return 'json';
  }

  if (
    lowerMime === 'application/xml' ||
    lowerMime === 'text/xml' ||
    lowerName.endsWith('.xml')
  ) {
    return 'xml';
  }

  if (
    lowerMime === 'text/csv' ||
    lowerName.endsWith('.csv')
  ) {
    return 'csv';
  }

  if (
    lowerMime === 'text/markdown' ||
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.markdown')
  ) {
    return 'markdown';
  }

  if (
    lowerMime === 'text/plain' ||
    lowerName.endsWith('.txt')
  ) {
    return 'text';
  }

  if (lowerName.endsWith('.docx')) {
    return 'docx';
  }

  if (lowerName.endsWith('.xlsx')) {
    return 'xlsx';
  }

  if (lowerName.endsWith('.pptx')) {
    return 'pptx';
  }

  return 'other';
}

export interface SourceDocumentFromPdfOptions {
  id: string;
  fileName: string;

  mimeType?: string;
  fileSize?: number;

  /**
   * Optional IndexedDB/storage references corresponding to
   * parsed.metadata.pdfImages in array order.
   *
   * The normalized document deliberately does not copy base64 image
   * payloads into SourceDocument.
   */
  imageStorageIds?: Array<string | undefined>;
}

/**
 * Convert the existing PDF parser result into the generalized
 * SourceDocument representation.
 *
 * This is currently an adapter only. Existing PDF generation behavior
 * continues to use pdfText/pdfImages until migration is complete.
 */
export function sourceDocumentFromParsedPdf(
  parsed: ParsedPdfContent,
  options: SourceDocumentFromPdfOptions,
): SourceDocument {
  const sections: SourceSection[] = [];

  if (parsed.layout?.length) {
    parsed.layout.forEach((item, index) => {
      const kind: SourceSection['kind'] =
        item.type === 'title' ||
        item.type === 'text' ||
        item.type === 'table' ||
        item.type === 'formula'
          ? item.type
          : 'other';

      sections.push({
        id: `section_${index + 1}`,
        kind,
        text: item.content,
        location: {
          pageNumber: item.page,
          sheetName: item.sheetName,
          cellRange: item.cellRange,
          bbox: item.position
            ? {
                x: item.position.x,
                y: item.position.y,
                width: item.position.width,
                height: item.position.height,
              }
            : undefined,
        },
      });
    });
  }

  /*
   * Some parsers do not expose layout blocks. Preserve the complete
   * extracted text as one section in that case rather than trying to
   * infer structure here.
   */
  if (sections.length === 0 && parsed.text) {
    sections.push({
      id: 'section_1',
      kind: 'text',
      text: parsed.text,
    });
  }

  const pdfImages = parsed.metadata?.pdfImages ?? [];

  const assets: SourceAsset[] = pdfImages.map((image, index) => ({
    id: image.id || `image_${index + 1}`,
    type: 'image',
    sourceAssetId: image.id,
    storageKey: options.imageStorageIds?.[index],
    description: image.description,
    pageNumber: image.pageNumber,
    width: image.width,
    height: image.height,
    visualRegions: image.visualRegions,
  }));

  const mimeType =
    options.mimeType ??
    'application/pdf';

  const sourceType =
    inferSourceDocumentType(
      options.fileName,
      mimeType,
    );

  return {
    id: options.id,

    fileName: options.fileName,
    mimeType,
    sourceType,

    content: parsed.text ?? '',

    sections,
    assets,

    metadata: {
      fileSize:
        options.fileSize ??
        parsed.metadata?.fileSize,

      pageCount:
        parsed.metadata?.pageCount,

      parser:
        parsed.metadata?.parser,

      processingTime:
        parsed.metadata?.processingTime,
    },
  };
}