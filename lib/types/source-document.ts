/**
 * Generalized source-document representation.
 *
 * This layer is intentionally independent of any individual parser.
 * PDF, Word, Excel, JSON, XML, text, and future source formats should
 * eventually normalize into this structure before lesson generation.
 */

export type SourceDocumentType =
  | 'pdf'
  | 'text'
  | 'markdown'
  | 'json'
  | 'xml'
  | 'docx'
  | 'xlsx'
  | 'csv'
  | 'pptx'
  | 'image'
  | 'other';

export type SourceSectionKind =
  | 'title'
  | 'text'
  | 'table'
  | 'formula'
  | 'other';

export interface SourceLocation {
  pageNumber?: number;

  sheetName?: string;
  cellRange?: string;

  jsonPath?: string;
  xmlPath?: string;

  /**
   * Bounding box in parser coordinates when available.
   */
  bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface SourceSection {
  id: string;
  kind: SourceSectionKind;

  title?: string;
  text: string;

  location?: SourceLocation;
}

export interface SourceAsset {
  id: string;
  type: 'image' | 'other';

  /**
   * Parser-provided identifier, if different from our normalized ID.
   */
  sourceAssetId?: string;

  storageKey?: string;
  mimeType?: string;

  description?: string;

  pageNumber?: number;
  width?: number;
  height?: number;
}

export interface DocumentDigest {
  /**
   * Compact semantic representation used for broad planning.
   *
   * The digest is never authoritative; exact details should be
   * retrieved from the original normalized document.
   */
  text: string;

  generatedAt?: string;
  model?: string;
}

export interface SourceDocumentMetadata {
  fileSize?: number;

  pageCount?: number;
  parser?: string;
  processingTime?: number;

  [key: string]: unknown;
}

export interface SourceDocument {
  id: string;

  fileName: string;
  mimeType: string;
  sourceType: SourceDocumentType;

  /**
   * Complete normalized textual representation.
   *
   * This must not be silently truncated. Later stages may construct
   * a digest or retrieve selected sections, but this remains the
   * canonical extracted text.
   */
  content: string;

  sections: SourceSection[];
  assets: SourceAsset[];

  metadata?: SourceDocumentMetadata;

  digest?: DocumentDigest;
}