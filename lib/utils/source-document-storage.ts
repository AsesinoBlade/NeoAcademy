/**
 * Source Document Storage
 *
 * Stores complete normalized source documents in IndexedDB.
 * sessionStorage should contain only lightweight SourceDocumentRef objects.
 */

import { nanoid } from 'nanoid';

import { createLogger } from '@/lib/logger';
import type {
  SourceDocument,
  SourceDocumentRef,
} from '@/lib/types/source-document';

import { db, type SourceDocumentRecord } from './database';

const log = createLogger('SourceDocumentStorage');

export async function storeSourceDocument(
  sessionId: string,
  document: SourceDocument,
): Promise<SourceDocumentRef> {
  const storageKey =
    document.id || `source_${nanoid(10)}`;

  const normalizedDocument: SourceDocument = {
    ...document,
    id: storageKey,
  };

  const record: SourceDocumentRecord = {
    id: storageKey,
    sessionId,
    fileName: normalizedDocument.fileName,
    sourceType: normalizedDocument.sourceType,
    document: normalizedDocument,
    createdAt: Date.now(),
  };

  await db.sourceDocuments.put(record);

  return {
    id: normalizedDocument.id,
    storageKey,
    fileName: normalizedDocument.fileName,
    sourceType: normalizedDocument.sourceType,
  };
}

export async function loadSourceDocument(
  storageKey: string,
): Promise<SourceDocument | null> {
  const record =
    await db.sourceDocuments.get(storageKey);

  return record?.document ?? null;
}

export async function loadSourceDocuments(
  refs: SourceDocumentRef[],
): Promise<SourceDocument[]> {
  const documents: SourceDocument[] = [];

  for (const ref of refs) {
    const document =
      await loadSourceDocument(ref.storageKey);

    if (!document) {
      log.warn(
        `Source document missing from IndexedDB: ${ref.storageKey}`,
      );
      continue;
    }

    documents.push(document);
  }

  return documents;
}

export async function deleteSourceDocumentsForSession(
  sessionId: string,
): Promise<void> {
  await db.sourceDocuments
    .where('sessionId')
    .equals(sessionId)
    .delete();
}

export async function cleanupOldSourceDocuments(
  hoursOld: number = 24,
): Promise<void> {
  const cutoff =
    Date.now() - hoursOld * 60 * 60 * 1000;

  const deleted =
    await db.sourceDocuments
      .where('createdAt')
      .below(cutoff)
      .delete();

  log.info(
    `Cleaned up ${deleted} source documents older than ${hoursOld} hours`,
  );
}