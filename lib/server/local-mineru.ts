import { spawn, execFileSync } from 'node:child_process';
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import sharp from 'sharp';

import { createLogger } from '@/lib/logger';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { unloadLocalLlm } from '@/lib/server/local-llm';

const log = createLogger('Local MinerU');

const DEFAULT_MINERU_EXECUTABLE =
  'D:\\AI\\MinerU\\.venv\\Scripts\\mineru-kit.exe';

const DEFAULT_MINERU_HOME =
  'D:\\AI\\MinerU\\home';

const DEFAULT_MINERU_TIER = 'standard';

const MINERU_TIMEOUT_MS = 15 * 60 * 1000;

const MAX_IMAGE_DIMENSION = 1280;
const IMAGE_WEBP_QUALITY = 75;

interface MinerUMiddleContentItem {
  type?: string;
  index?: number;
  bbox?: number[];
  content?: unknown;
}

interface MinerUMiddleBlock {
  type?: string;
  index?: number;
  bbox?: number[];
  content?: MinerUMiddleContentItem[];
}

interface MinerUMiddlePage {
  page_idx?: number;
  blocks?: MinerUMiddleBlock[];
}

interface MinerUMiddleDocument {
  schema?: string;
  schema_version?: string;
  is_full_document?: boolean;
  pages?: MinerUMiddlePage[];
  metadata?: Record<string, unknown>;
}

export interface LocalMinerUInput {
  fileName: string;
  buffer: Buffer;
}

export interface LocalMinerUResult {
  fileName: string;
  data: ParsedPdfContent;
}

function getMinerUExecutable(): string {
  return (
    process.env.MINERU_EXECUTABLE?.trim() ||
    DEFAULT_MINERU_EXECUTABLE
  );
}

function getMinerUHome(): string {
  return (
    process.env.MINERU_HOME?.trim() ||
    DEFAULT_MINERU_HOME
  );
}

function getMinerUTier(): string {
  return (
    process.env.MINERU_TIER?.trim() ||
    DEFAULT_MINERU_TIER
  );
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      execFileSync(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      return;
    }

    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Best-effort cleanup only.
    }
  }
}

async function runMinerU(
  executable: string,
  mineruHome: string,
  inputPaths: string[],
  outputDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const args = [
    'parse',
    ...inputPaths,
    '--tier',
    getMinerUTier(),
    '--pages',
    'all',
    '--format',
    'zip',
    '--output',
    outputDir,
  ];

  log.info(
    `[MinerU] Starting local batch parse for ${inputPaths.length} document(s)`,
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      executable,
      args,
      {
        cwd: path.dirname(outputDir),
        env: {
          ...process.env,
          MINERU_HOME: mineruHome,
        },
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (
      error?: Error,
    ) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onAbort = () => {
      log.warn('[MinerU] Parse aborted; terminating process tree');
      killProcessTree(child.pid);
      finish(new Error('MinerU parse cancelled'));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener(
      'abort',
      onAbort,
      { once: true },
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();

      if (stdout.length > 200_000) {
        stdout = stdout.slice(-200_000);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();

      if (stderr.length > 200_000) {
        stderr = stderr.slice(-200_000);
      }
    });

    child.on('error', (error) => {
      finish(error);
    });

    child.on('exit', (code, exitSignal) => {
      if (settled) {
        return;
      }

      if (code === 0) {
        if (stdout.trim()) {
          log.info(
            `[MinerU] ${stdout.trim().slice(-4000)}`,
          );
        }

        finish();
        return;
      }

      const detail =
        stderr.trim() ||
        stdout.trim() ||
        `signal=${exitSignal ?? 'none'}`;

      finish(
        new Error(
          `MinerU exited with code ${code ?? 'null'}: ` +
            detail.slice(-8000),
        ),
      );
    });

    const timeout = setTimeout(() => {
      log.error(
        `[MinerU] Timed out after ${MINERU_TIMEOUT_MS} ms`,
      );

      killProcessTree(child.pid);

      finish(
        new Error(
          `MinerU timed out after ${Math.round(
            MINERU_TIMEOUT_MS / 1000,
          )} seconds`,
        ),
      );
    }, MINERU_TIMEOUT_MS);
  });
}

function contentItemText(
  item: MinerUMiddleContentItem,
): string {
  return typeof item.content === 'string'
    ? item.content
    : '';
}

function blockText(
  block: MinerUMiddleBlock,
): string {
  return (block.content ?? [])
    .map(contentItemText)
    .filter(Boolean)
    .join('\n');
}

function bboxToPosition(
  bbox: number[] | undefined,
):
  | {
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | undefined {
  if (!bbox || bbox.length < 4) {
    return undefined;
  }

  const [
    x0,
    y0,
    x1,
    y1,
  ] = bbox;

  if (
    ![x0, y0, x1, y1].every(
      (value) => Number.isFinite(value),
    )
  ) {
    return undefined;
  }

  return {
    x: x0,
    y: y0,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
  };
}

function inferLayoutType(
  blockType: string,
):
  | 'title'
  | 'text'
  | 'table'
  | 'formula'
  | null {
  const normalized =
    blockType.toLowerCase();

  if (
    normalized === 'header' ||
    normalized === 'title'
  ) {
    return 'title';
  }

  if (
    normalized === 'text' ||
    normalized === 'paragraph'
  ) {
    return 'text';
  }

  if (normalized === 'table') {
    return 'table';
  }

  if (
    normalized.includes('formula') ||
    normalized.includes('equation')
  ) {
    return 'formula';
  }

  return null;
}

function visualKindForItem(
  blockType: string,
  item: MinerUMiddleContentItem,
): 'image' | 'table' | 'chart' | null {
  const itemType =
    (item.type ?? '').toLowerCase();

  if (
    itemType.includes('chart') ||
    blockType === 'chart'
  ) {
    return 'chart';
  }

  if (
    itemType.includes('table') ||
    blockType === 'table'
  ) {
    return 'table';
  }

  if (
    itemType.includes('image') ||
    blockType === 'image'
  ) {
    return 'image';
  }

  return null;
}

function expectedVisualPath(
  pageIndex: number,
  kind: 'image' | 'table' | 'chart',
  itemIndex: number,
): string {
  return (
    `images/page_${pageIndex}_` +
    `${kind}_${itemIndex}.jpg`
  );
}

async function convertImageToDataUrl(
  imageBuffer: Buffer,
): Promise<{
  dataUrl: string;
  width?: number;
  height?: number;
}> {
  const result =
    await sharp(imageBuffer)
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality: IMAGE_WEBP_QUALITY,
        effort: 4,
      })
      .toBuffer({
        resolveWithObject: true,
      });

  return {
    dataUrl:
      `data:image/webp;base64,` +
      result.data.toString('base64'),
    width: result.info.width,
    height: result.info.height,
  };
}

async function parseMinerUZip(
  zipPath: string,
): Promise<ParsedPdfContent> {
  const zipBuffer =
    await readFile(zipPath);

  const zip =
    await JSZip.loadAsync(zipBuffer);

  const middleEntry =
    zip.file('middle_json.json');

  if (!middleEntry) {
    throw new Error(
      `MinerU ZIP is missing middle_json.json: ${zipPath}`,
    );
  }

  const middleRaw =
    await middleEntry.async('string');

  const middle =
    JSON.parse(
      middleRaw,
    ) as MinerUMiddleDocument;

  const pages =
    Array.isArray(middle.pages)
      ? middle.pages
      : [];

  const layout: NonNullable<
    ParsedPdfContent['layout']
  > = [];

  const pdfImages: NonNullable<
    NonNullable<
      ParsedPdfContent['metadata']
    >['pdfImages']
  > = [];

  const pageTexts: string[] = [];

  let visualIndex = 0;

  const zipEntryByLowerPath =
    new Map(
      Object.values(zip.files).map(
        (entry) => [
          entry.name.toLowerCase(),
          entry,
        ],
      ),
    );

  const usedVisualPaths =
    new Set<string>();

  const findVisualEntry = (
    pageIndex: number,
    kind: 'image' | 'table' | 'chart',
    itemIndex: number,
  ) => {
    const exactPath =
      expectedVisualPath(
        pageIndex,
        kind,
        itemIndex,
      );

    const exactEntry =
      zipEntryByLowerPath.get(
        exactPath.toLowerCase(),
      );

    if (
      exactEntry &&
      !usedVisualPaths.has(
        exactEntry.name.toLowerCase(),
      )
    ) {
      usedVisualPaths.add(
        exactEntry.name.toLowerCase(),
      );

      return {
        entry: exactEntry,
        path: exactEntry.name,
        fallback: false,
      };
    }

    const prefix =
      `images/page_${pageIndex}_${kind}_`
        .toLowerCase();

    const fallbackEntry =
      Object.values(zip.files)
        .filter(
          (entry) =>
            !entry.dir &&
            entry.name
              .toLowerCase()
              .startsWith(prefix) &&
            entry.name
              .toLowerCase()
              .endsWith('.jpg') &&
            !usedVisualPaths.has(
              entry.name.toLowerCase(),
            ),
        )
        .sort(
          (a, b) =>
            a.name.localeCompare(
              b.name,
              undefined,
              {
                numeric: true,
              },
            ),
        )[0];

    if (!fallbackEntry) {
      return null;
    }

    usedVisualPaths.add(
      fallbackEntry.name.toLowerCase(),
    );

    return {
      entry: fallbackEntry,
      path: fallbackEntry.name,
      fallback: true,
    };
  };

  for (const page of pages) {
    const pageIndex =
      Number.isFinite(page.page_idx)
        ? Number(page.page_idx)
        : 0;

    const pageNumber =
      pageIndex + 1;

    const pageTextParts: string[] = [];

    for (const block of page.blocks ?? []) {
      const blockType =
        (block.type ?? '').toLowerCase();

      if (blockType === 'page_number') {
        continue;
      }

      const text =
        blockText(block).trim();

      const layoutType =
        inferLayoutType(blockType);

      if (layoutType && text) {
        layout.push({
          page: pageNumber,
          type: layoutType,
          content: text,
          position:
            bboxToPosition(block.bbox),
        });

        pageTextParts.push(text);
      }

      for (const item of block.content ?? []) {
        const visualKind =
          visualKindForItem(
            blockType,
            item,
          );

        if (!visualKind) {
          continue;
        }

        const itemIndex =
          Number.isFinite(item.index)
            ? Number(item.index)
            : 0;

        const expectedPath =
          expectedVisualPath(
            pageIndex,
            visualKind,
            itemIndex,
          );

        const visualMatch =
          findVisualEntry(
            pageIndex,
            visualKind,
            itemIndex,
          );

        if (!visualMatch) {
          log.warn(
            `[MinerU] Missing visual asset ${expectedPath}`,
          );
          continue;
        }

        if (visualMatch.fallback) {
          log.info(
            `[MinerU] Visual filename fallback: ` +
              `${expectedPath} -> ${visualMatch.path}`,
          );
        }

        const imageBuffer =
          await visualMatch.entry.async(
            'nodebuffer',
          );

        const converted =
          await convertImageToDataUrl(
            imageBuffer,
          );

        visualIndex++;

        pdfImages.push({
          id: `img_${visualIndex}`,
          src: converted.dataUrl,
          pageNumber,
          description:
            `MinerU ${visualKind} from page ${pageNumber}`,
          width: converted.width,
          height: converted.height,
        });
      }
    }

    if (pageTextParts.length > 0) {
      pageTexts.push(
        `===== PAGE ${pageNumber} =====\n` +
          pageTextParts.join('\n\n'),
      );
    }
  }

  const text =
    pageTexts.join('\n\n');

  log.info(
    `[MinerU] Normalized ${pages.length} pages, ` +
      `${layout.length} text/layout blocks, ` +
      `${pdfImages.length} visual assets, ` +
      `${text.length} chars`,
  );

  return {
    text,

    // Avoid duplicating base64 image payloads. Existing generation
    // code consumes metadata.pdfImages first.
    images: [],

    layout,

    metadata: {
      pageCount: pages.length,
      parser: 'mineru-local',
      pdfImages,
      mineruSchema:
        middle.schema,
      mineruSchemaVersion:
        middle.schema_version,
      mineruFullDocument:
        middle.is_full_document,
    },
  };
}

export async function parseLocalMinerUBatch(
  inputs: LocalMinerUInput[],
  signal?: AbortSignal,
): Promise<LocalMinerUResult[]> {
  if (inputs.length === 0) {
    return [];
  }

  const executable =
    getMinerUExecutable();

  const mineruHome =
    getMinerUHome();

  await access(executable);
  await access(mineruHome);

  const tempRoot =
    await mkdtemp(
      path.join(
        os.tmpdir(),
        'neoacademy-mineru-',
      ),
    );

  const inputDir =
    path.join(tempRoot, 'input');

  const outputDir =
    path.join(tempRoot, 'output');

  const fs =
    await import('node:fs/promises');

  await fs.mkdir(
    inputDir,
    { recursive: true },
  );

  await fs.mkdir(
    outputDir,
    { recursive: true },
  );

  const prepared: Array<{
    fileName: string;
    inputPath: string;
    zipPath: string;
  }> = [];

  try {
    for (
      let index = 0;
      index < inputs.length;
      index++
    ) {
      const input =
        inputs[index];

      const stem =
        `document_${String(
          index + 1,
        ).padStart(3, '0')}`;

      const inputPath =
        path.join(
          inputDir,
          `${stem}.pdf`,
        );

      const zipPath =
        path.join(
          outputDir,
          `${stem}.zip`,
        );

      await writeFile(
        inputPath,
        input.buffer,
      );

      prepared.push({
        fileName: input.fileName,
        inputPath,
        zipPath,
      });
    }

    log.info(
      '[MinerU] Unloading local LLM before batch parse',
    );

    const unloadResult =
      await unloadLocalLlm();

    if (!unloadResult.success) {
      throw new Error(
        'Failed to unload local LLM before MinerU: ' +
          (unloadResult.message ??
            'unknown error'),
      );
    }

    await runMinerU(
      executable,
      mineruHome,
      prepared.map(
        (item) => item.inputPath,
      ),
      outputDir,
      signal,
    );

    const results: LocalMinerUResult[] =
      [];

    for (const item of prepared) {
      await access(item.zipPath);

      const data =
        await parseMinerUZip(
          item.zipPath,
        );

      results.push({
        fileName:
          item.fileName,
        data,
      });
    }

    return results;
  } finally {
    try {
      await rm(
        tempRoot,
        {
          recursive: true,
          force: true,
        },
      );
    } catch (error) {
      log.warn(
        '[MinerU] Failed to remove temporary directory:',
        error,
      );
    }
  }
}