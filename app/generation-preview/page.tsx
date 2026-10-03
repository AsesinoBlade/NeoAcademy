'use client';

import { useEffect, useState, Suspense, useRef } from 'react';

import { generateTTSForScene, useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { logGenerationProgress } from '@/lib/generation/progress-log';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, Sparkles, AlertCircle, AlertTriangle, ArrowLeft, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  loadImageMapping,
  loadPdfBlob,
  cleanupOldImages,
  storeImages,
} from '@/lib/utils/image-storage';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { db } from '@/lib/utils/database';
import { MAX_SOURCE_TEXT_CHARS, MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { sourceDocumentFromParsedPdf } from '@/lib/source/source-document';
import {
  cleanupOldSourceDocuments,
  storeSourceDocument,
} from '@/lib/utils/source-document-storage';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { nanoid } from 'nanoid';
import type { Stage } from '@/lib/types/stage';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  LocalizedVisualRegion,
} from '@/lib/types/generation';
import { AgentRevealModal } from '@/components/agent/agent-reveal-modal';
import { createLogger } from '@/lib/logger';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { applyDiagramAnnotationsToScene } from '@/lib/generation/diagram-annotations';
import type { MediaGenerationRequest } from '@/lib/media/types';
import { type GenerationSessionState, ALL_STEPS, getActiveSteps } from './types';
import { StepVisualizer } from './components/visualizers';

const log = createLogger('GenerationPreview');

function isDirectTextSource(
  fileName: string,
  mimeType?: string,
): boolean {
  const lowerName = fileName.toLowerCase();
  const lowerMime = (mimeType || '').toLowerCase();

  return (
    lowerMime === 'text/plain' ||
    lowerMime === 'text/markdown' ||
    lowerMime === 'application/json' ||
    lowerMime === 'text/json' ||
    lowerMime === 'application/xml' ||
    lowerMime === 'text/xml' ||
    lowerMime === 'text/csv' ||
    lowerName.endsWith('.txt') ||
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.markdown') ||
    lowerName.endsWith('.json') ||
    lowerName.endsWith('.xml') ||
    lowerName.endsWith('.csv')
  );
}

function normalizeDirectSourceText(
  fileName: string,
  mimeType: string | undefined,
  rawText: string,
): string {
  const lowerName = fileName.toLowerCase();
  const lowerMime = (mimeType || '').toLowerCase();

  const isJson =
    lowerMime === 'application/json' ||
    lowerMime === 'text/json' ||
    lowerName.endsWith('.json');

  if (isJson) {
    try {
      const parsed = JSON.parse(rawText);

      // Pretty formatting retains JSON's structure while making it much
      // easier for downstream LLM prompts to read.
      return JSON.stringify(parsed, null, 2);
    } catch (error) {
      throw new Error(
        `${fileName}: invalid JSON ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }
  }

  const isXml =
    lowerMime === 'application/xml' ||
    lowerMime === 'text/xml' ||
    lowerName.endsWith('.xml');

  if (isXml) {
    const parsed =
      new DOMParser().parseFromString(
        rawText,
        'application/xml',
      );

    if (
      parsed.querySelector('parsererror')
    ) {
      throw new Error(
        `${fileName}: invalid XML`,
      );
    }
  }

  // TXT, Markdown, CSV and valid XML retain their original textual
  // representation. CSV therefore preserves rows and columns exactly.
  return rawText;
}

function isDocxSource(
  fileName: string,
  mimeType?: string,
): boolean {
  const lowerName = fileName.toLowerCase();
  const lowerMime =
    (mimeType || '').toLowerCase();

  return (
    lowerMime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lowerName.endsWith('.docx')
  );
}

/**
 * Extract visible WordprocessingML text while retaining common
 * inline Word controls such as tabs and line breaks.
 */
function extractWordNodeText(
  node: Element,
): string {
  let result = '';

  const visit = (current: Node) => {
    if (
      current.nodeType ===
      Node.TEXT_NODE
    ) {
      return;
    }

    if (
      current.nodeType !==
      Node.ELEMENT_NODE
    ) {
      return;
    }

    const element =
      current as Element;

    switch (element.localName) {
      case 't':
        result +=
          element.textContent || '';
        return;

      case 'tab':
        result += '\t';
        return;

      case 'br':
      case 'cr':
        result += '\n';
        return;
    }

    for (
      const child of
      Array.from(element.childNodes)
    ) {
      visit(child);
    }
  };

  visit(node);

  return result;
}

function getWordParagraphStyle(
  paragraph: Element,
): string | undefined {
  const styleElements =
    paragraph.getElementsByTagNameNS(
      '*',
      'pStyle',
    );

  const style =
    styleElements.item(0);

  if (!style) {
    return undefined;
  }

  return (
    style.getAttribute('w:val') ||
    style.getAttribute('val') ||
    undefined
  );
}

function escapeMarkdownTableCell(
  value: string,
): string {
  return value
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function wordTableToData(
  table: Element,
): string[][] {
  const rows: string[][] = [];

  const rowElements =
    Array.from(table.children).filter(
      (element) =>
        element.localName === 'tr',
    );

  for (const row of rowElements) {
    const cells =
      Array.from(row.children).filter(
        (element) =>
          element.localName === 'tc',
      );

    rows.push(
      cells.map((cell) => {
        const paragraphs =
          Array.from(
            cell.getElementsByTagNameNS(
              '*',
              'p',
            ),
          );

        return paragraphs
          .map((paragraph) =>
            extractWordNodeText(
              paragraph,
            ).trim(),
          )
          .filter(Boolean)
          .join(' ')
          .trim();
      }),
    );
  }

  return rows;
}

function wordTableToMarkdown(
  rows: string[][],
): string {
  if (rows.length === 0) {
    return '';
  }

  const width =
    Math.max(
      1,
      ...rows.map(
        (row) => row.length,
      ),
    );

  const normalized =
    rows.map((row) =>
      Array.from(
        { length: width },
        (_, index) =>
          escapeMarkdownTableCell(
            row[index] || '',
          ),
      ),
    );

  const firstRow =
    normalized[0];

  const header =
    `| ${firstRow.join(' | ')} |`;

  const separator =
    `| ${Array.from(
      { length: width },
      () => '---',
    ).join(' | ')} |`;

  const body =
    normalized
      .slice(1)
      .map(
        (row) =>
          `| ${row.join(' | ')} |`,
      );

  return [
    header,
    separator,
    ...body,
  ].join('\n');
}

function isXlsxSource(
  fileName: string,
  mimeType?: string,
): boolean {
  const lowerName =
    fileName.toLowerCase();

  const lowerMime =
    (mimeType || '').toLowerCase();

  return (
    lowerMime ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    lowerName.endsWith('.xlsx')
  );
}

function resolveXlsxRelationshipPath(
  target: string,
): string | undefined {
  if (
    !target ||
    /^(?:https?:|data:)/i.test(
      target,
    )
  ) {
    return undefined;
  }

  const normalized =
    target
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');

  if (
    normalized.startsWith('xl/')
  ) {
    return normalized;
  }

  const parts = [
    'xl',
    ...normalized.split('/'),
  ];

  const resolved:
    string[] = [];

  for (const part of parts) {
    if (
      !part ||
      part === '.'
    ) {
      continue;
    }

    if (part === '..') {
      resolved.pop();
      continue;
    }

    resolved.push(part);
  }

  return resolved.join('/');
}

function resolveXlsxPartRelationshipPath(
  sourcePartPath: string,
  target: string,
): string | undefined {
  if (
    !target ||
    /^(?:https?:|data:)/i.test(
      target,
    )
  ) {
    return undefined;
  }

  const normalizedTarget =
    target
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');

  if (
    normalizedTarget.startsWith(
      'xl/',
    )
  ) {
    return normalizedTarget;
  }

  const sourceParts =
    sourcePartPath
      .replace(/\\/g, '/')
      .split('/');

  sourceParts.pop();

  const combined = [
    ...sourceParts,
    ...normalizedTarget.split('/'),
  ];

  const resolved:
    string[] = [];

  for (const part of combined) {
    if (
      !part ||
      part === '.'
    ) {
      continue;
    }

    if (part === '..') {
      resolved.pop();
      continue;
    }

    resolved.push(part);
  }

  return resolved.join('/');
}

function getXlsxTextContent(
  element: Element,
): string {
  return Array.from(
    element.getElementsByTagNameNS(
      '*',
      't',
    ),
  )
    .map(
      (textNode) =>
        textNode.textContent || '',
    )
    .join('');
}

function formatXlsxValue(
  value: string,
): string {
  if (
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes('|') ||
    value.includes('"')
  ) {
    return JSON.stringify(value);
  }

  return value;
}

interface ParsedXlsxCell {
  address: string;
  value: string;
  formula?: string;
  cachedValue?: string;
}

interface ParsedXlsxSheet {
  name: string;
  range?: string;
  rows: Array<{
    rowNumber: number;
    cells: ParsedXlsxCell[];
  }>;
}

interface XlsxRichImageReference {
  imagePath: string;
  mimeType: string;
}

interface XlsxDrawingObject {
  relationshipId: string;
  kind: 'image' | 'chart';
  fromCell?: string;
  toCell?: string;
}

interface ParsedXlsxChart {
  title?: string;
  chartType: string;
  series: Array<{
    name?: string;
    categories: string[];
    values: string[];
  }>;
}

async function getXlsxRichImageReferences(
  zip: {
    file(
      path: string,
    ): {
      async(
        type: 'string',
      ): Promise<string>;
    } | null;
  },
): Promise<Map<string, XlsxRichImageReference>> {
  const result =
    new Map<
      string,
      XlsxRichImageReference
    >();

  const metadataEntry =
    zip.file(
      'xl/metadata.xml',
    );

  const richValueEntry =
    zip.file(
      'xl/richData/rdrichvalue.xml',
    );

  const richStructureEntry =
    zip.file(
      'xl/richData/rdrichvaluestructure.xml',
    );

  const richValueRelEntry =
    zip.file(
      'xl/richData/richValueRel.xml',
    );

  const richValueRelRelsEntry =
    zip.file(
      'xl/richData/_rels/richValueRel.xml.rels',
    );

  if (
    !metadataEntry ||
    !richValueEntry ||
    !richStructureEntry ||
    !richValueRelEntry ||
    !richValueRelRelsEntry
  ) {
    return result;
  }

  const [
    metadataXml,
    richValueXml,
    richStructureXml,
    richValueRelXml,
    richValueRelRelsXml,
  ] = await Promise.all([
    metadataEntry.async('string'),
    richValueEntry.async('string'),
    richStructureEntry.async('string'),
    richValueRelEntry.async('string'),
    richValueRelRelsEntry.async(
      'string',
    ),
  ]);

  const parser =
    new DOMParser();

  const metadataDocument =
    parser.parseFromString(
      metadataXml,
      'application/xml',
    );

  const richValueDocument =
    parser.parseFromString(
      richValueXml,
      'application/xml',
    );

  const richStructureDocument =
    parser.parseFromString(
      richStructureXml,
      'application/xml',
    );

  const richValueRelDocument =
    parser.parseFromString(
      richValueRelXml,
      'application/xml',
    );

  const richValueRelRelsDocument =
    parser.parseFromString(
      richValueRelRelsXml,
      'application/xml',
    );

  if (
    metadataDocument.querySelector(
      'parsererror',
    ) ||
    richValueDocument.querySelector(
      'parsererror',
    ) ||
    richStructureDocument.querySelector(
      'parsererror',
    ) ||
    richValueRelDocument.querySelector(
      'parsererror',
    ) ||
    richValueRelRelsDocument.querySelector(
      'parsererror',
    )
  ) {
    return result;
  }

  // valueMetadata entries are addressed by the worksheet's vm attribute.
  // vm is 1-based, while the backing arrays are naturally 0-based.
  const valueMetadata =
    metadataDocument
      .getElementsByTagNameNS(
        '*',
        'valueMetadata',
      )
      .item(0);

  if (!valueMetadata) {
    return result;
  }

  const metadataBlocks =
    Array.from(
      valueMetadata.children,
    ).filter(
      (element) =>
        element.localName === 'bk',
    );

  const futureMetadata =
    metadataDocument
      .getElementsByTagNameNS(
        '*',
        'futureMetadata',
      )
      .item(0);

  const futureBlocks =
    futureMetadata
      ? Array.from(
          futureMetadata.children,
        ).filter(
          (element) =>
            element.localName === 'bk',
        )
      : [];

  const richValues =
    Array.from(
      richValueDocument
        .getElementsByTagNameNS(
          '*',
          'rv',
        ),
    );

  const structures =
    Array.from(
      richStructureDocument
        .getElementsByTagNameNS(
          '*',
          's',
        ),
    );

  const richValueRelationships =
    Array.from(
      richValueRelDocument
        .getElementsByTagNameNS(
          '*',
          'rel',
        ),
    );

  const relationshipTargets =
    new Map<string, string>();

  for (
    const relationship of
    Array.from(
      richValueRelRelsDocument
        .getElementsByTagNameNS(
          '*',
          'Relationship',
        ),
    )
  ) {
    const id =
      relationship.getAttribute(
        'Id',
      );

    const target =
      relationship.getAttribute(
        'Target',
      );

    if (
      id &&
      target
    ) {
      relationshipTargets.set(
        id,
        target,
      );
    }
  }

  for (
    let metadataIndex = 0;
    metadataIndex <
    metadataBlocks.length;
    metadataIndex++
  ) {
    const block =
      metadataBlocks[
        metadataIndex
      ];

    const record =
      block
        .getElementsByTagNameNS(
          '*',
          'rc',
        )
        .item(0);

    if (!record) {
      continue;
    }

    const futureIndex =
      Number(
        record.getAttribute(
          'v',
        ),
      );

    if (
      !Number.isInteger(
        futureIndex,
      ) ||
      futureIndex < 0 ||
      futureIndex >=
        futureBlocks.length
    ) {
      continue;
    }

    const futureBlock =
      futureBlocks[
        futureIndex
      ];

    const richValueBinding =
      futureBlock
        .getElementsByTagNameNS(
          '*',
          'rvb',
        )
        .item(0);

    if (!richValueBinding) {
      continue;
    }

    const richValueIndex =
      Number(
        richValueBinding.getAttribute(
          'i',
        ),
      );

    if (
      !Number.isInteger(
        richValueIndex,
      ) ||
      richValueIndex < 0 ||
      richValueIndex >=
        richValues.length
    ) {
      continue;
    }

    const richValue =
      richValues[
        richValueIndex
      ];

    const structureIndex =
      Number(
        richValue.getAttribute(
          's',
        ),
      );

    if (
      !Number.isInteger(
        structureIndex,
      ) ||
      structureIndex < 0 ||
      structureIndex >=
        structures.length
    ) {
      continue;
    }

    const structure =
      structures[
        structureIndex
      ];

    const structureType =
      structure.getAttribute(
        't',
      );

    if (
      structureType !==
      '_localImage'
    ) {
      continue;
    }

    const keys =
      Array.from(
        structure.children,
      ).filter(
        (element) =>
          element.localName === 'k',
      );

    const localImageKeyIndex =
      keys.findIndex(
        (key) =>
          key.getAttribute(
            'n',
          ) ===
          '_rvRel:LocalImageIdentifier',
      );

    if (
      localImageKeyIndex < 0
    ) {
      continue;
    }

    const values =
      Array.from(
        richValue.children,
      ).filter(
        (element) =>
          element.localName === 'v',
      );

    const relationshipOrdinal =
      Number(
        values[
          localImageKeyIndex
        ]?.textContent,
      );

    if (
      !Number.isInteger(
        relationshipOrdinal,
      ) ||
      relationshipOrdinal < 0 ||
      relationshipOrdinal >=
        richValueRelationships.length
    ) {
      continue;
    }

    const richRelationship =
      richValueRelationships[
        relationshipOrdinal
      ];

    const relationshipId =
      richRelationship.getAttribute(
        'r:id',
      ) ||
      richRelationship.getAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'id',
      );

    if (!relationshipId) {
      continue;
    }

    const target =
      relationshipTargets.get(
        relationshipId,
      );

    if (!target) {
      continue;
    }

    const imagePath =
      resolveXlsxPartRelationshipPath(
        'xl/richData/richValueRel.xml',
        target,
      );

    if (!imagePath) {
      continue;
    }

    const mimeType =
      getDocxImageMimeType(
        imagePath,
      );

    if (!mimeType) {
      continue;
    }

    // Worksheet vm values are 1-based.
    result.set(
      String(metadataIndex + 1),
      {
        imagePath,
        mimeType,
      },
    );
  }

  return result;
}

function getXlsxColumnLetters(
  zeroBasedColumn: number,
): string {
  let value =
    zeroBasedColumn + 1;

  let result = '';

  while (value > 0) {
    const remainder =
      (value - 1) % 26;

    result =
      String.fromCharCode(
        65 + remainder,
      ) + result;

    value =
      Math.floor(
        (value - 1) / 26,
      );
  }

  return result;
}

function xlsxMarkerToCell(
  marker: Element | null,
): string | undefined {
  if (!marker) {
    return undefined;
  }

  const colText =
    marker
      .getElementsByTagNameNS(
        '*',
        'col',
      )
      .item(0)
      ?.textContent;

  const rowText =
    marker
      .getElementsByTagNameNS(
        '*',
        'row',
      )
      .item(0)
      ?.textContent;

  if (
    colText === null ||
    colText === undefined ||
    rowText === null ||
    rowText === undefined
  ) {
    return undefined;
  }

  const column =
    Number(colText);

  const row =
    Number(rowText);

  if (
    !Number.isInteger(column) ||
    column < 0 ||
    !Number.isInteger(row) ||
    row < 0
  ) {
    return undefined;
  }

  return (
    getXlsxColumnLetters(
      column,
    ) +
    String(row + 1)
  );
}

function getXlsxDrawingObjects(
  drawingDocument: Document,
): XlsxDrawingObject[] {
  const objects:
    XlsxDrawingObject[] = [];

  const anchors = [
    ...Array.from(
      drawingDocument
        .getElementsByTagNameNS(
          '*',
          'twoCellAnchor',
        ),
    ),
    ...Array.from(
      drawingDocument
        .getElementsByTagNameNS(
          '*',
          'oneCellAnchor',
        ),
    ),
    ...Array.from(
      drawingDocument
        .getElementsByTagNameNS(
          '*',
          'absoluteAnchor',
        ),
    ),
  ];

  for (const anchor of anchors) {
    const from =
      anchor
        .getElementsByTagNameNS(
          '*',
          'from',
        )
        .item(0);

    const to =
      anchor
        .getElementsByTagNameNS(
          '*',
          'to',
        )
        .item(0);

    const fromCell =
      xlsxMarkerToCell(from);

    const toCell =
      xlsxMarkerToCell(to);

    const blips =
      Array.from(
        anchor
          .getElementsByTagNameNS(
            '*',
            'blip',
          ),
      );

    for (const blip of blips) {
      const relationshipId =
        blip.getAttribute(
          'r:embed',
        ) ||
        blip.getAttributeNS(
          'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
          'embed',
        );

      if (relationshipId) {
        objects.push({
          relationshipId,
          kind: 'image',
          fromCell,
          toCell,
        });
      }
    }

    const charts =
      Array.from(
        anchor
          .getElementsByTagNameNS(
            '*',
            'chart',
          ),
      );

    for (const chart of charts) {
      const relationshipId =
        chart.getAttribute(
          'r:id',
        ) ||
        chart.getAttributeNS(
          'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
          'id',
        );

      if (relationshipId) {
        objects.push({
          relationshipId,
          kind: 'chart',
          fromCell,
          toCell,
        });
      }
    }
  }

  return objects;
}

function getXlsxCachedPointValues(
  parent: Element,
): string[] {
  return Array.from(
    parent
      .getElementsByTagNameNS(
        '*',
        'pt',
      ),
  )
    .map((point) =>
      point
        .getElementsByTagNameNS(
          '*',
          'v',
        )
        .item(0)
        ?.textContent ?? '',
    )
    .filter(Boolean);
}

function getXlsxSeriesText(
  element: Element | null,
): string | undefined {
  if (!element) {
    return undefined;
  }

  const directValue =
    element
      .getElementsByTagNameNS(
        '*',
        'v',
      )
      .item(0)
      ?.textContent;

  if (directValue) {
    return directValue;
  }

  const text =
    getXlsxTextContent(
      element,
    );

  return text || undefined;
}

function getXlsxChartType(
  chartDocument: Document,
): string {
  const knownTypes = [
    'barChart',
    'bar3DChart',
    'lineChart',
    'line3DChart',
    'pieChart',
    'pie3DChart',
    'doughnutChart',
    'areaChart',
    'area3DChart',
    'scatterChart',
    'bubbleChart',
    'radarChart',
    'surfaceChart',
    'surface3DChart',
    'stockChart',
  ];

  for (const type of knownTypes) {
    if (
      chartDocument
        .getElementsByTagNameNS(
          '*',
          type,
        )
        .length > 0
    ) {
      return type;
    }
  }

  return 'chart';
}

function parseXlsxChart(
  chartDocument: Document,
): ParsedXlsxChart {
  const titleElement =
    chartDocument
      .getElementsByTagNameNS(
        '*',
        'title',
      )
      .item(0);

  const title =
    titleElement
      ? getXlsxTextContent(
          titleElement,
        ) || undefined
      : undefined;

  const seriesElements =
    Array.from(
      chartDocument
        .getElementsByTagNameNS(
          '*',
          'ser',
        ),
    );

  const series =
    seriesElements.map(
      (seriesElement) => {
        const tx =
          seriesElement
            .getElementsByTagNameNS(
              '*',
              'tx',
            )
            .item(0);

        const name =
          getXlsxSeriesText(tx);

        const strCaches =
          Array.from(
            seriesElement
              .getElementsByTagNameNS(
                '*',
                'strCache',
              ),
          );

        const numCaches =
          Array.from(
            seriesElement
              .getElementsByTagNameNS(
                '*',
                'numCache',
              ),
          );

        const categories =
          strCaches.length > 0
            ? getXlsxCachedPointValues(
                strCaches[0],
              )
            : numCaches.length > 1
              ? getXlsxCachedPointValues(
                  numCaches[0],
                )
              : [];

        const values =
          numCaches.length > 0
            ? getXlsxCachedPointValues(
                numCaches[
                  numCaches.length - 1
                ],
              )
            : [];

        return {
          name,
          categories,
          values,
        };
      },
    );

  return {
    title,
    chartType:
      getXlsxChartType(
        chartDocument,
      ),
    series,
  };
}

function formatXlsxChartText(
  chart: ParsedXlsxChart,
): string {
  const lines:
    string[] = [];

  lines.push(
    `Chart type: ${chart.chartType}`,
  );

  if (chart.title) {
    lines.push(
      `Title: ${chart.title}`,
    );
  }

  if (chart.series.length === 0) {
    lines.push(
      'Series: none cached in chart XML',
    );
  } else {
    chart.series.forEach(
      (series, index) => {
        lines.push(
          `Series ${index + 1}: ${series.name || '(unnamed)'}`,
        );

        if (
          series.categories.length > 0
        ) {
          lines.push(
            `Categories: ${series.categories.join(', ')}`,
          );
        }

        if (
          series.values.length > 0
        ) {
          lines.push(
            `Values: ${series.values.join(', ')}`,
          );
        }
      },
    );
  }

  return lines.join('\n');
}

async function parseXlsxSource(
  sourceBlob: Blob,
  fileName: string,
  signal?: AbortSignal,
): Promise<ParsedPdfContent> {
  const JSZip =
    (await import('jszip')).default;

  const startedAt =
    performance.now();

  let zip;

  try {
    zip =
      await JSZip.loadAsync(
        await sourceBlob.arrayBuffer(),
      );
  } catch (error) {
    throw new Error(
      `${fileName}: invalid or unreadable XLSX ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  const workbookEntry =
    zip.file('xl/workbook.xml');

  if (!workbookEntry) {
    throw new Error(
      `${fileName}: XLSX is missing xl/workbook.xml`,
    );
  }

  const workbookXml =
    await workbookEntry.async(
      'string',
    );

  const workbookDocument =
    new DOMParser().parseFromString(
      workbookXml,
      'application/xml',
    );

  if (
    workbookDocument.querySelector(
      'parsererror',
    )
  ) {
    throw new Error(
      `${fileName}: invalid workbook XML`,
    );
  }

  // ----------------------------------------------------------
  // Workbook relationships:
  // rId -> xl/worksheets/sheetN.xml
  // ----------------------------------------------------------

  const relationshipTargets =
    new Map<string, string>();

  const relationshipsEntry =
    zip.file(
      'xl/_rels/workbook.xml.rels',
    );

  if (relationshipsEntry) {
    const relationshipsXml =
      await relationshipsEntry.async(
        'string',
      );

    const relationshipsDocument =
      new DOMParser().parseFromString(
        relationshipsXml,
        'application/xml',
      );

    if (
      !relationshipsDocument.querySelector(
        'parsererror',
      )
    ) {
      const relationships =
        Array.from(
          relationshipsDocument
            .getElementsByTagNameNS(
              '*',
              'Relationship',
            ),
        );

      for (
        const relationship of
        relationships
      ) {
        const id =
          relationship.getAttribute(
            'Id',
          );

        const target =
          relationship.getAttribute(
            'Target',
          );

        if (
          id &&
          target
        ) {
          relationshipTargets.set(
            id,
            target,
          );
        }
      }
    }
  }

  // ----------------------------------------------------------
  // Shared strings.
  // ----------------------------------------------------------

  const sharedStrings:
    string[] = [];

  const sharedStringsEntry =
    zip.file(
      'xl/sharedStrings.xml',
    );

  if (sharedStringsEntry) {
    const sharedStringsXml =
      await sharedStringsEntry.async(
        'string',
      );

    const sharedStringsDocument =
      new DOMParser().parseFromString(
        sharedStringsXml,
        'application/xml',
      );

    if (
      !sharedStringsDocument.querySelector(
        'parsererror',
      )
    ) {
      const stringItems =
        Array.from(
          sharedStringsDocument
            .getElementsByTagNameNS(
              '*',
              'si',
            ),
        );

      for (
        const stringItem of
        stringItems
      ) {
        sharedStrings.push(
          getXlsxTextContent(
            stringItem,
          ),
        );
      }
    }
  }

  // ----------------------------------------------------------
  // Workbook sheet list.
  // ----------------------------------------------------------

  const richImageReferences =
    await getXlsxRichImageReferences(
      zip,
    );

  const sheetElements =
    Array.from(
      workbookDocument
        .getElementsByTagNameNS(
          '*',
          'sheet',
        ),
    );

  if (
    sheetElements.length === 0
  ) {
    throw new Error(
      `${fileName}: workbook contains no worksheets`,
    );
  }

  const parsedSheets:
    ParsedXlsxSheet[] = [];

  const layout:
    NonNullable<
      ParsedPdfContent['layout']
    > = [];

  const canonicalBlocks:
    string[] = [];

  const extractedImages:
    ExtractedSourceImage[] = [];

  const imageLocations:
    Array<{
      sheetName: string;
      cellRange?: string;
    }> = [];

  const extractedRichImageKeys =
    new Set<string>();

  let chartCount = 0;
  let totalCellCount = 0;
  let formulaCount = 0;

  for (
    let sheetIndex = 0;
    sheetIndex <
    sheetElements.length;
    sheetIndex++
  ) {
    const sheetElement =
      sheetElements[
        sheetIndex
      ];

    const sheetName =
      sheetElement.getAttribute(
        'name',
      ) ||
      `Sheet${sheetIndex + 1}`;

    const relationshipId =
      sheetElement.getAttribute(
        'r:id',
      ) ||
      sheetElement.getAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'id',
      );

    if (!relationshipId) {
      log.warn(
        `[Generation] XLSX sheet has no relationship ID: ${sheetName}`,
      );
      continue;
    }

    const target =
      relationshipTargets.get(
        relationshipId,
      );

    if (!target) {
      log.warn(
        `[Generation] XLSX sheet relationship not found: ${sheetName}`,
      );
      continue;
    }

    const sheetPath =
      resolveXlsxRelationshipPath(
        target,
      );

    if (!sheetPath) {
      continue;
    }

    const sheetEntry =
      zip.file(sheetPath);

    if (!sheetEntry) {
      log.warn(
        `[Generation] XLSX worksheet XML missing: ${sheetPath}`,
      );
      continue;
    }

    const sheetXml =
      await sheetEntry.async(
        'string',
      );

    const sheetDocument =
      new DOMParser().parseFromString(
        sheetXml,
        'application/xml',
      );

    if (
      sheetDocument.querySelector(
        'parsererror',
      )
    ) {
      throw new Error(
        `${fileName}: invalid worksheet XML for ${sheetName}`,
      );
    }

    const worksheetRelationships =
      new Map<string, string>();

    const sheetPathParts =
      sheetPath.split('/');

    const sheetFileName =
      sheetPathParts.pop();

    const sheetDirectory =
      sheetPathParts.join('/');

    const sheetRelsPath =
      sheetFileName
        ? `${sheetDirectory}/_rels/${sheetFileName}.rels`
        : undefined;

    if (sheetRelsPath) {
      const sheetRelsEntry =
        zip.file(
          sheetRelsPath,
        );

      if (sheetRelsEntry) {
        const sheetRelsXml =
          await sheetRelsEntry.async(
            'string',
          );

        const sheetRelsDocument =
          new DOMParser().parseFromString(
            sheetRelsXml,
            'application/xml',
          );

        if (
          !sheetRelsDocument.querySelector(
            'parsererror',
          )
        ) {
          const relationships =
            Array.from(
              sheetRelsDocument
                .getElementsByTagNameNS(
                  '*',
                  'Relationship',
                ),
            );

          for (
            const relationship of
            relationships
          ) {
            const id =
              relationship.getAttribute(
                'Id',
              );

            const target =
              relationship.getAttribute(
                'Target',
              );

            if (
              id &&
              target
            ) {
              worksheetRelationships.set(
                id,
                target,
              );
            }
          }
        }
      }
    }

    const drawingElements =
      Array.from(
        sheetDocument
          .getElementsByTagNameNS(
            '*',
            'drawing',
          ),
      );

    for (
      const drawingElement of
      drawingElements
    ) {
      const drawingRelationshipId =
        drawingElement.getAttribute(
          'r:id',
        ) ||
        drawingElement.getAttributeNS(
          'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
          'id',
        );

      if (
        !drawingRelationshipId
      ) {
        continue;
      }

      const drawingTarget =
        worksheetRelationships.get(
          drawingRelationshipId,
        );

      if (!drawingTarget) {
        continue;
      }

      const drawingPath =
        resolveXlsxPartRelationshipPath(
          sheetPath,
          drawingTarget,
        );

      if (!drawingPath) {
        continue;
      }

      const drawingEntry =
        zip.file(
          drawingPath,
        );

      if (!drawingEntry) {
        continue;
      }

      const drawingXml =
        await drawingEntry.async(
          'string',
        );

      const drawingDocument =
        new DOMParser().parseFromString(
          drawingXml,
          'application/xml',
        );

      if (
        drawingDocument.querySelector(
          'parsererror',
        )
      ) {
        continue;
      }

      const drawingPathParts =
        drawingPath.split('/');

      const drawingFileName =
        drawingPathParts.pop();

      const drawingDirectory =
        drawingPathParts.join('/');

      const drawingRelsPath =
        drawingFileName
          ? `${drawingDirectory}/_rels/${drawingFileName}.rels`
          : undefined;

      const drawingRelationships =
        new Map<string, string>();

      if (drawingRelsPath) {
        const drawingRelsEntry =
          zip.file(
            drawingRelsPath,
          );

        if (drawingRelsEntry) {
          const drawingRelsXml =
            await drawingRelsEntry.async(
              'string',
            );

          const drawingRelsDocument =
            new DOMParser().parseFromString(
              drawingRelsXml,
              'application/xml',
            );

          if (
            !drawingRelsDocument.querySelector(
              'parsererror',
            )
          ) {
            const relationships =
              Array.from(
                drawingRelsDocument
                  .getElementsByTagNameNS(
                    '*',
                    'Relationship',
                  ),
              );

            for (
              const relationship of
              relationships
            ) {
              const id =
                relationship.getAttribute(
                  'Id',
                );

              const target =
                relationship.getAttribute(
                  'Target',
                );

              if (
                id &&
                target
              ) {
                drawingRelationships.set(
                  id,
                  target,
                );
              }
            }
          }
        }
      }

      const drawingObjects =
        getXlsxDrawingObjects(
          drawingDocument,
        );

      for (
        const drawingObject of
        drawingObjects
      ) {
        const target =
          drawingRelationships.get(
            drawingObject.relationshipId,
          );

        if (!target) {
          continue;
        }

        const resolvedTarget =
          resolveXlsxPartRelationshipPath(
            drawingPath,
            target,
          );

        if (!resolvedTarget) {
          continue;
        }

        const cellRange =
          drawingObject.fromCell &&
          drawingObject.toCell
            ? `${drawingObject.fromCell}:${drawingObject.toCell}`
            : drawingObject.fromCell;

        if (
          drawingObject.kind ===
          'image'
        ) {
          const mimeType =
            getDocxImageMimeType(
              resolvedTarget,
            );

          if (!mimeType) {
            log.warn(
              `[Generation] Skipping unsupported XLSX embedded image: ${resolvedTarget}`,
            );
            continue;
          }

          const imageEntry =
            zip.file(
              resolvedTarget,
            );

          if (!imageEntry) {
            continue;
          }

          const bytes =
            await imageEntry.async(
              'uint8array',
            );

          if (
            bytes.length === 0
          ) {
            continue;
          }

          extractedImages.push({
            id:
              `xlsx_image_${extractedImages.length + 1}`,
            fileName:
              resolvedTarget
                .split('/')
                .pop() ||
              `xlsx_image_${extractedImages.length + 1}`,
            mimeType,
            bytes,
          });

          imageLocations.push({
            sheetName,
            cellRange,
          });

          layout.push({
            page:
              sheetIndex + 1,
            type: 'image',
            content:
              `[Embedded image ${extractedImages.length}]`,
            sheetName,
            cellRange,
          });

          continue;
        }

        if (
          drawingObject.kind ===
          'chart'
        ) {
          const chartEntry =
            zip.file(
              resolvedTarget,
            );

          if (!chartEntry) {
            continue;
          }

          const chartXml =
            await chartEntry.async(
              'string',
            );

          const chartDocument =
            new DOMParser().parseFromString(
              chartXml,
              'application/xml',
            );

          if (
            chartDocument.querySelector(
              'parsererror',
            )
          ) {
            continue;
          }

          const chart =
            parseXlsxChart(
              chartDocument,
            );

          chartCount++;

          const chartText =
            formatXlsxChartText(
              chart,
            );

          layout.push({
            page:
              sheetIndex + 1,
            type: 'table',
            content:
              chartText,
            sheetName,
            cellRange,
          });

          canonicalBlocks.push(
            `===== CHART ${chartCount}: ${sheetName}${cellRange ? ` (${cellRange})` : ''} =====`,
            chartText,
          );
        }
      }
    }

    const dimensionElement =
      sheetDocument
        .getElementsByTagNameNS(
          '*',
          'dimension',
        )
        .item(0);

    const declaredRange =
      dimensionElement
        ?.getAttribute('ref') ||
      undefined;

    const parsedRows:
      ParsedXlsxSheet['rows'] = [];

    const rowElements =
      Array.from(
        sheetDocument
          .getElementsByTagNameNS(
            '*',
            'row',
          ),
      );

    for (
      let rowIndex = 0;
      rowIndex <
      rowElements.length;
      rowIndex++
    ) {
      const rowElement =
        rowElements[
          rowIndex
        ];

      const explicitRow =
        Number(
          rowElement.getAttribute(
            'r',
          ),
        );

      const rowNumber =
        Number.isFinite(
          explicitRow,
        ) &&
        explicitRow > 0
          ? explicitRow
          : rowIndex + 1;

      const parsedCells:
        ParsedXlsxCell[] = [];

      const cellElements =
        Array.from(
          rowElement
            .getElementsByTagNameNS(
              '*',
              'c',
            ),
        );

      for (
        const cellElement of
        cellElements
      ) {
        const address =
          cellElement.getAttribute(
            'r',
          ) ||
          `row${rowNumber}`;

        const cellType =
          cellElement.getAttribute(
            't',
          ) || '';

        const valueMetadataIndex =
          cellElement.getAttribute(
            'vm',
          );

        if (
          valueMetadataIndex
        ) {
          const richImageReference =
            richImageReferences.get(
              valueMetadataIndex,
            );

          if (richImageReference) {
            const richImageKey =
              `${sheetName}:${address}:${valueMetadataIndex}`;

            if (
              !extractedRichImageKeys.has(
                richImageKey,
              )
            ) {
              const imageEntry =
                zip.file(
                  richImageReference
                    .imagePath,
                );

              if (imageEntry) {
                const bytes =
                  await imageEntry.async(
                    'uint8array',
                  );

                if (
                  bytes.length > 0
                ) {
                  extractedRichImageKeys.add(
                    richImageKey,
                  );

                  extractedImages.push({
                    id:
                      `xlsx_image_${extractedImages.length + 1}`,
                    fileName:
                      richImageReference
                        .imagePath
                        .split('/')
                        .pop() ||
                      `xlsx_image_${extractedImages.length + 1}`,
                    mimeType:
                      richImageReference
                        .mimeType,
                    bytes,
                  });

                  imageLocations.push({
                    sheetName,
                    cellRange:
                      address,
                  });

                  layout.push({
                    page:
                      sheetIndex + 1,
                    type: 'image',
                    content:
                      `[Embedded in-cell image ${extractedImages.length}]`,
                    sheetName,
                    cellRange:
                      address,
                  });

                  canonicalBlocks.push(
                    `===== IN-CELL IMAGE ${extractedImages.length}: ${sheetName}!${address} =====`,
                    `[Embedded image ${extractedImages.length}]`,
                  );
                }
              }
            }

            parsedCells.push({
              address,
              value:
                `[Embedded image at ${sheetName}!${address}]`,
            });

            totalCellCount++;
            continue;
          }
        }

        const formulaElement =
          cellElement
            .getElementsByTagNameNS(
              '*',
              'f',
            )
            .item(0);

        const valueElement =
          cellElement
            .getElementsByTagNameNS(
              '*',
              'v',
            )
            .item(0);

        const rawValue =
          valueElement
            ?.textContent ??
          '';

        const formula =
          formulaElement
            ?.textContent ||
          undefined;

        let value = '';

        switch (cellType) {
          case 's': {
            const sharedIndex =
              Number(rawValue);

            value =
              Number.isInteger(
                sharedIndex,
              ) &&
              sharedIndex >= 0
                ? sharedStrings[
                    sharedIndex
                  ] ?? rawValue
                : rawValue;

            break;
          }

          case 'inlineStr':
            value =
              getXlsxTextContent(
                cellElement,
              );
            break;

          case 'b':
            value =
              rawValue === '1'
                ? 'TRUE'
                : 'FALSE';
            break;

          case 'e':
            value =
              rawValue
                ? `#ERROR(${rawValue})`
                : '#ERROR';
            break;

          default:
            value =
              rawValue;
            break;
        }

        if (
          !formula &&
          value === ''
        ) {
          continue;
        }

        totalCellCount++;

        if (formula) {
          formulaCount++;
        }

        parsedCells.push({
          address,
          value:
            formula
              ? formula
              : value,
          formula,
          cachedValue:
            formula
              ? value
              : undefined,
        });
      }

      if (
        parsedCells.length > 0
      ) {
        parsedRows.push({
          rowNumber,
          cells:
            parsedCells,
        });
      }
    }

    parsedSheets.push({
      name:
        sheetName,
      range:
        declaredRange,
      rows:
        parsedRows,
    });

    const sheetTitle =
      declaredRange
        ? `${sheetName} (${declaredRange})`
        : sheetName;

    layout.push({
      page:
        sheetIndex + 1,
      type: 'title',
      content:
        `Worksheet: ${sheetTitle}`,
      sheetName,
      cellRange:
        declaredRange,
    });

    const rowText =
      parsedRows
        .map(
          (row) => {
            const cells =
              row.cells.map(
                (cell) => {
                  if (
                    cell.formula
                  ) {
                    const cached =
                      cell.cachedValue !==
                        undefined &&
                      cell.cachedValue !== ''
                        ? ` [cached: ${formatXlsxValue(cell.cachedValue)}]`
                        : '';

                    return (
                      `${cell.address}: =${cell.formula}${cached}`
                    );
                  }

                  return (
                    `${cell.address}: ${formatXlsxValue(cell.value)}`
                  );
                },
              );

            return (
              `Row ${row.rowNumber}: ` +
              cells.join(' | ')
            );
          },
        )
        .join('\n');

    const tableText =
      rowText ||
      '(worksheet contains no populated cells)';

    layout.push({
      page:
        sheetIndex + 1,
      type: 'table',
      content:
        tableText,
      sheetName,
      cellRange:
        declaredRange,
    });

    canonicalBlocks.push(
      `===== WORKSHEET: ${sheetTitle} =====`,
      tableText,
    );
  }

  if (
    parsedSheets.length === 0
  ) {
    throw new Error(
      `${fileName}: no readable worksheets were found`,
    );
  }

  const analyzedImages =
    await analyzeSourceImages(
      extractedImages,
      signal,
      'XLSX',
    );

  const analyzedPdfImages:
    NonNullable<
      NonNullable<
        ParsedPdfContent['metadata']
      >['pdfImages']
    > = [];

  const visualTextBlocks:
    string[] = [];

  for (
    let index = 0;
    index <
    analyzedImages.length;
    index++
  ) {
    const analyzed =
      analyzedImages[index];

    const image =
      analyzed.metadata
        ?.pdfImages?.[0];

    if (!image) {
      continue;
    }

    analyzedPdfImages.push({
      ...image,
      id:
        extractedImages[index]?.id ||
        image.id,
      pageNumber: 1,
    });

    const location =
      imageLocations[index];

    if (
      analyzed.text?.trim()
    ) {
      visualTextBlocks.push(
        `--- XLSX EMBEDDED IMAGE ${index + 1}` +
          `${location?.sheetName ? ` [${location.sheetName}${location.cellRange ? ` ${location.cellRange}` : ''}]` : ''} ---\n` +
          analyzed.text.trim(),
      );
    }
  }

  if (
    visualTextBlocks.length > 0
  ) {
    canonicalBlocks.push(
      '===== XLSX EMBEDDED IMAGE ANALYSIS =====',
      ...visualTextBlocks,
    );
  }

  const content =
    canonicalBlocks
      .join('\n\n')
      .trim();

  return {
    text:
      content,
    images: [],
    layout,

    metadata: {
      pageCount:
        parsedSheets.length,
      fileName,
      fileSize:
        sourceBlob.size,
      parser:
        'xlsx-jszip',
      processingTime:
        Math.round(
          performance.now() -
            startedAt,
        ),

      workbookSheetCount:
        parsedSheets.length,

      workbookSheets:
        parsedSheets.map(
          (sheet) => ({
            name:
              sheet.name,
            range:
              sheet.range,
            populatedRowCount:
              sheet.rows.length,
            populatedCellCount:
              sheet.rows.reduce(
                (
                  count,
                  row,
                ) =>
                  count +
                  row.cells.length,
                0,
              ),
          }),
        ),

      workbookCellCount:
        totalCellCount,

      workbookFormulaCount:
        formulaCount,

      workbookChartCount:
        chartCount,

      workbookEmbeddedImageCount:
        extractedImages.length,

      pdfImages:
        analyzedPdfImages,
    },
  };
}

function getDocxImageMimeType(
  path: string,
): string | undefined {
  const lower =
    path.toLowerCase();

  if (
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg')
  ) {
    return 'image/jpeg';
  }

  if (lower.endsWith('.png')) {
    return 'image/png';
  }

  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }

  return undefined;
}

function resolveDocxRelationshipPath(
  target: string,
): string | undefined {
  if (
    !target ||
    /^(?:https?:|data:)/i.test(
      target,
    )
  ) {
    return undefined;
  }

  const normalized =
    target
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');

  if (
    normalized.startsWith(
      'word/',
    )
  ) {
    return normalized;
  }

  const parts =
    [
      'word',
      ...normalized.split('/'),
    ];

  const resolved:
    string[] = [];

  for (const part of parts) {
    if (
      !part ||
      part === '.'
    ) {
      continue;
    }

    if (part === '..') {
      resolved.pop();
      continue;
    }

    resolved.push(part);
  }

  return resolved.join('/');
}

interface ExtractedSourceImage {
  id: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

async function analyzeSourceImages(
  images: ExtractedSourceImage[],
  signal?: AbortSignal,
  sourceLabel: 'DOCX' | 'XLSX' = 'DOCX',
): Promise<ParsedPdfContent[]> {
  if (images.length === 0) {
    return [];
  }

  const message =
    `[Generation] ${sourceLabel} vision phase: ${images.length} embedded image(s)`;

  log.info(message);
  logGenerationProgress(message);

  const formData =
    new FormData();

  for (const image of images) {
    const imageBuffer =
      image.bytes.buffer.slice(
        image.bytes.byteOffset,
        image.bytes.byteOffset +
          image.bytes.byteLength,
      ) as ArrayBuffer;

    const file =
      new File(
        [imageBuffer],
        image.fileName,
        {
          type: image.mimeType,
        },
      );

    formData.append(
      'sources',
      file,
      image.fileName,
    );
  }

  const response =
    await fetch(
      '/api/parse-pdf/mineru-batch',
      {
        method: 'POST',
        body: formData,
        signal,
      },
    );

  if (!response.ok) {
    const errorData =
      await response
        .json()
        .catch(() => ({}));

    throw new Error(
      errorData.error ||
        `${sourceLabel} embedded-image analysis failed`,
    );
  }

  const result =
    await response.json();

  const batchResults =
    Array.isArray(
      result?.data?.data,
    )
      ? result.data.data
      : Array.isArray(
            result?.data,
          )
        ? result.data
        : [];

  if (
    batchResults.length !==
    images.length
  ) {
    throw new Error(
      `${sourceLabel} vision returned ${batchResults.length} result(s), ` +
        `but ${images.length} image(s) were submitted`,
    );
  }

  const parsedResults =
    batchResults.map(
      (
        item: {
          data?: ParsedPdfContent;
        },
        index: number,
      ) => {
        if (!item?.data) {
          throw new Error(
            `${sourceLabel} embedded image ${index + 1} returned no parsed data`,
          );
        }

        return item.data;
      },
    );

  log.info(
    `[Generation] ${sourceLabel} vision phase complete`,
  );
  logGenerationProgress(
    `[Generation] ${sourceLabel} vision phase complete`,
  );

  return parsedResults;
}

async function parseDocxSource(
  sourceBlob: Blob,
  fileName: string,
  signal?: AbortSignal,
): Promise<ParsedPdfContent> {
  const JSZip =
    (await import('jszip')).default;

  const startedAt =
    performance.now();

  let zip;

  try {
    zip =
      await JSZip.loadAsync(
        await sourceBlob.arrayBuffer(),
      );
  } catch (error) {
    throw new Error(
      `${fileName}: invalid or unreadable DOCX ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  const documentEntry =
    zip.file(
      'word/document.xml',
    );

  if (!documentEntry) {
    throw new Error(
      `${fileName}: DOCX is missing word/document.xml`,
    );
  }

  const documentXml =
    await documentEntry.async(
      'string',
    );

  const relationshipTargets =
    new Map<string, string>();

  const relationshipsEntry =
    zip.file(
      'word/_rels/document.xml.rels',
    );

  if (relationshipsEntry) {
    const relationshipsXml =
      await relationshipsEntry.async(
        'string',
      );

    const relationshipsDocument =
      new DOMParser().parseFromString(
        relationshipsXml,
        'application/xml',
      );

    if (
      !relationshipsDocument.querySelector(
        'parsererror',
      )
    ) {
      const relationships =
        Array.from(
          relationshipsDocument
            .getElementsByTagNameNS(
              '*',
              'Relationship',
            ),
        );

      for (
        const relationship of
        relationships
      ) {
        const id =
          relationship.getAttribute(
            'Id',
          );

        const target =
          relationship.getAttribute(
            'Target',
          );

        const type =
          relationship.getAttribute(
            'Type',
          ) || '';

        if (
          id &&
          target &&
          /\/image$/i.test(type)
        ) {
          relationshipTargets.set(
            id,
            target,
          );
        }
      }
    }
  }

  const xmlDocument =
    new DOMParser().parseFromString(
      documentXml,
      'application/xml',
    );

  if (
    xmlDocument.querySelector(
      'parsererror',
    )
  ) {
    throw new Error(
      `${fileName}: invalid DOCX document XML`,
    );
  }

  const bodyElements =
    xmlDocument
      .getElementsByTagNameNS(
        '*',
        'body',
      );

  const body =
    bodyElements.item(0);

  if (!body) {
    throw new Error(
      `${fileName}: DOCX contains no document body`,
    );
  }

  const layout:
    NonNullable<
      ParsedPdfContent['layout']
    > = [];

  const tables:
    NonNullable<
      ParsedPdfContent['tables']
    > = [];

  const canonicalBlocks:
    string[] = [];

  const extractedImages:
    ExtractedSourceImage[] = [];

  const extractedRelationshipIds =
    new Set<string>();

  for (
    const child of
    Array.from(body.children)
  ) {
    const blips =
      Array.from(
        child.getElementsByTagNameNS(
          '*',
          'blip',
        ),
      );

    for (const blip of blips) {
      const relationshipId =
        blip.getAttribute(
          'r:embed',
        ) ||
        blip.getAttributeNS(
          'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
          'embed',
        );

      if (
        !relationshipId ||
        extractedRelationshipIds.has(
          relationshipId,
        )
      ) {
        continue;
      }

      const target =
        relationshipTargets.get(
          relationshipId,
        );

      if (!target) {
        continue;
      }

      const imagePath =
        resolveDocxRelationshipPath(
          target,
        );

      if (!imagePath) {
        continue;
      }

      const mimeType =
        getDocxImageMimeType(
          imagePath,
        );

      if (!mimeType) {
        log.warn(
          `[Generation] Skipping unsupported DOCX embedded image: ${imagePath}`,
        );
        continue;
      }

      const imageEntry =
        zip.file(imagePath);

      if (!imageEntry) {
        log.warn(
          `[Generation] DOCX image relationship points to missing file: ${imagePath}`,
        );
        continue;
      }

      const bytes =
        await imageEntry.async(
          'uint8array',
        );

      if (
        bytes.length === 0
      ) {
        continue;
      }

      extractedRelationshipIds.add(
        relationshipId,
      );

      extractedImages.push({
        id:
          `docx_image_${extractedImages.length + 1}`,
        fileName:
          imagePath
            .split('/')
            .pop() ||
          `docx_image_${extractedImages.length + 1}`,
        mimeType,
        bytes,
      });

      layout.push({
        page: 1,
        type: 'image',
        content:
          `[Embedded image ${extractedImages.length}]`,
      });

      canonicalBlocks.push(
        `[Embedded image ${extractedImages.length}]`,
      );
    }

    if (
      child.localName === 'p'
    ) {
      const text =
        extractWordNodeText(
          child,
        ).trim();

      if (!text) {
        continue;
      }

      const style =
        getWordParagraphStyle(
          child,
        );

      const isTitle =
        !!style &&
        (
          /^title$/i.test(style) ||
          /^heading\s*[1-6]$/i.test(style)
        );

      layout.push({
        page: 1,
        type:
          isTitle
            ? 'title'
            : 'text',
        content: text,
      });

      if (isTitle) {
        const headingLevelMatch =
          style?.match(
            /^heading\s*([1-6])$/i,
          );

        const headingLevel =
          headingLevelMatch
            ? Number(
                headingLevelMatch[1],
              )
            : 1;

        canonicalBlocks.push(
          `${'#'.repeat(
            headingLevel,
          )} ${text}`,
        );
      } else {
        canonicalBlocks.push(
          text,
        );
      }

      continue;
    }

    if (
      child.localName === 'tbl'
    ) {
      const rows =
        wordTableToData(
          child,
        );

      if (
        rows.length === 0
      ) {
        continue;
      }

      const tableText =
        wordTableToMarkdown(
          rows,
        );

      tables.push({
        page: 1,
        data: rows,
      });

      layout.push({
        page: 1,
        type: 'table',
        content: tableText,
      });

      canonicalBlocks.push(
        tableText,
      );
    }
  }

  const analyzedImages =
    await analyzeSourceImages(
      extractedImages,
      signal,
      'DOCX',
    );

  const analyzedPdfImages:
    NonNullable<
      NonNullable<
        ParsedPdfContent['metadata']
      >['pdfImages']
    > = [];

  const visualTextBlocks:
    string[] = [];

  for (
    let index = 0;
    index <
    analyzedImages.length;
    index++
  ) {
    const analyzed =
      analyzedImages[index];

    const image =
      analyzed.metadata
        ?.pdfImages?.[0];

    if (!image) {
      continue;
    }

    analyzedPdfImages.push({
      ...image,
      id:
        extractedImages[index]?.id ||
        image.id,
      pageNumber: 1,
    });

    if (
      analyzed.text?.trim()
    ) {
      visualTextBlocks.push(
        `--- DOCX EMBEDDED IMAGE ${index + 1} ---\n` +
          analyzed.text.trim(),
      );
    }
  }

  if (
    visualTextBlocks.length > 0
  ) {
    canonicalBlocks.push(
      '===== DOCX EMBEDDED IMAGE ANALYSIS =====',
      ...visualTextBlocks,
    );
  }

  const content =
    canonicalBlocks
      .filter(Boolean)
      .join('\n\n')
      .trim();

  if (!content) {
    throw new Error(
      `${fileName}: DOCX contains no readable text or tables`,
    );
  }

  return {
    text: content,
    images: [],
    tables,
    layout,

    metadata: {
      pageCount: 1,
      fileName,
      fileSize:
        sourceBlob.size,
      parser: 'docx-jszip',
      processingTime:
        Math.round(
          performance.now() -
            startedAt,
        ),
      pdfImages:
        analyzedPdfImages,
      docxEmbeddedImageCount:
        extractedImages.length,
    },
  };
}

async function objectUrlToDataUrl(
  objectUrl: string,
): Promise<string> {
  const response =
    await fetch(objectUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to read generated image blob (${response.status})`,
    );
  }

  const blob =
    await response.blob();

  return await new Promise<string>(
    (
      resolve,
      reject,
    ) => {
      const reader =
        new FileReader();

      reader.onerror =
        () =>
          reject(
            new Error(
              'Failed to convert generated image to data URL',
            ),
          );

      reader.onload =
        () => {
          if (
            typeof reader.result ===
            'string'
          ) {
            resolve(
              reader.result,
            );
          }
          else {
            reject(
              new Error(
                'Generated image conversion returned no data',
              ),
            );
          }
        };

      reader.readAsDataURL(
        blob,
      );
    },
  );
}

function GenerationPreviewContent() {
  const router = useRouter();
  const { t } = useI18n();
  const { generateRemaining, stop: stopSceneGeneration } = useSceneGenerator();
  const hasStartedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [session, setSession] = useState<GenerationSessionState | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [streamingOutlines, setStreamingOutlines] = useState<SceneOutline[] | null>(null);
  const [truncationWarnings, setTruncationWarnings] = useState<string[]>([]);
  const [webSearchSources, setWebSearchSources] = useState<Array<{ title: string; url: string }>>(
    [],
  );
  const [showAgentReveal, setShowAgentReveal] = useState(false);
  const [generatedAgents, setGeneratedAgents] = useState<
    Array<{
      id: string;
      name: string;
      role: string;
      persona: string;
      avatar: string;
      color: string;
      priority: number;
    }>
  >([]);
  const agentRevealResolveRef = useRef<(() => void) | null>(null);

  // Compute active steps based on session state
  const activeSteps = getActiveSteps(session);

  // Load session from sessionStorage
  useEffect(() => {
    cleanupOldImages(24).catch((e) => log.error(e));
    cleanupOldSourceDocuments(24).catch((e) => log.error(e));

    const saved = sessionStorage.getItem('generationSession');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as GenerationSessionState;
        setSession(parsed);
      } catch (e) {
        log.error('Failed to parse generation session:', e);
      }
    }
    setSessionLoaded(true);
  }, []);

  // Abort all in-flight requests on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      stopSceneGeneration();
    };
  }, [stopSceneGeneration]);

  // Get API credentials from localStorage
  const getApiHeaders = () => {
    const modelConfig = getCurrentModelConfig();
    const settings = useSettingsStore.getState();
    const imageProviderConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
    const videoProviderConfig = settings.videoProvidersConfig?.[settings.videoProviderId];
    return {
      'Content-Type': 'application/json',
      'x-model': modelConfig.modelString,
      'x-api-key': modelConfig.apiKey,
      'x-base-url': modelConfig.baseUrl,
      'x-provider-type': modelConfig.providerType || '',
      'x-requires-api-key': modelConfig.requiresApiKey ? 'true' : 'false',
      // Image generation provider
      'x-image-provider': settings.imageProviderId || '',
      'x-image-model': settings.imageModelId || '',
      'x-image-api-key': imageProviderConfig?.apiKey || '',
      'x-image-base-url': imageProviderConfig?.baseUrl || '',
      // Video generation provider
      'x-video-provider': settings.videoProviderId || '',
      'x-video-model': settings.videoModelId || '',
      'x-video-api-key': videoProviderConfig?.apiKey || '',
      'x-video-base-url': videoProviderConfig?.baseUrl || '',
      // Media generation toggles
      'x-image-generation-enabled': String(settings.imageGenerationEnabled ?? false),
      'x-video-generation-enabled': String(settings.videoGenerationEnabled ?? false),
    };
  };

  // Auto-start generation when session is loaded
  useEffect(() => {
    if (session && !hasStartedRef.current) {
      hasStartedRef.current = true;
      startGeneration();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Main generation flow
  const startGeneration = async () => {
    if (!session) return;

    // Create AbortController for this generation run
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    // Use a local mutable copy so we can update it after PDF parsing
    let currentSession = session;

    // Use the generation session id as the durable classroom id.
    // This exists before source parsing, so early failures still get
    // a persistent history card.
    const stageId =
      currentSession.sessionId ||
      nanoid(10);

    const stage: Stage = {
      id: stageId,
      name: extractTopicFromRequirement(
        currentSession.requirements.requirement,
      ),
      description: '',
      language:
        currentSession.requirements.language ||
        'en-US',
      style: 'professional',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const persistGenerationState = async (
      status: 'generating' | 'completed' | 'failed',
      options?: {
        error?: string;
        requireSuccess?: boolean;
      },
    ) => {
      const currentState = useStageStore.getState();

      const activeStage =
        currentState.stage?.id === stage.id
          ? currentState.stage
          : stage;

      const activeScenes =
        currentState.stage?.id === stage.id
          ? currentState.scenes
          : [];

      const response = await fetch('/api/classroom', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          stage: activeStage,
          scenes: activeScenes,
          currentSceneId:
            currentState.stage?.id === stage.id
              ? currentState.currentSceneId
              : null,
          chats:
            currentState.stage?.id === stage.id
              ? currentState.chats
              : [],
          outlines:
            currentState.stage?.id === stage.id
              ? currentState.outlines
              : [],
          status,
          error: options?.error,
          requirement:
            currentSession.requirements.requirement,
        }),
      });

      if (!response.ok) {
        const message =
          `Classroom persistence failed (${response.status})`;

        if (options?.requireSuccess) {
          throw new Error(message);
        }

        log.warn(message);
      }
    };

    setError(null);
    setCurrentStepIndex(0);

    try {
      await persistGenerationState(
        'generating',
        {
          requireSuccess: true,
        },
      );
      // Compute active steps for this session (recomputed after session mutations)

      // Keep Docker/Kokoro/Whisper out of memory while Ollama performs
      // agent, outline, content, and action generation.
      log.info('[Generation] Stopping local speech services before LLM generation');

      const stopSpeechResponse = await fetch('/api/local-speech-services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
        signal,
      });

      const stopSpeechData = await stopSpeechResponse.json();

      if (!stopSpeechResponse.ok || !stopSpeechData.success) {
        throw new Error(
          stopSpeechData.error || 'Failed to stop local speech services before LLM generation',
        );
      }

      log.info('[Generation] Local speech services stopped; LLM generation starting');
      let activeSteps = getActiveSteps(currentSession);

      // Determine whether one or more PDFs still need analysis.
      // Legacy singular fields are retained for sessions created before
      // multi-PDF support.
      let pdfDocuments =
        currentSession.pdfDocuments?.length
          ? currentSession.pdfDocuments
          : currentSession.pdfStorageKey
            ? [
                {
                  storageKey: currentSession.pdfStorageKey,
                  fileName:
                    currentSession.pdfFileName ||
                    'document.pdf',
                },
              ]
            : [];

      const hasPdfToAnalyze =
        pdfDocuments.length > 0 &&
        !currentSession.pdfText;

      if (!hasPdfToAnalyze) {
        const firstNonPdfIdx =
          activeSteps.findIndex(
            (s) => s.id !== 'pdf-analysis',
          );

        setCurrentStepIndex(
          Math.max(0, firstNonPdfIdx),
        );
      }

      if (hasPdfToAnalyze) {
        const sourceParsingMessage =
          `[Generation] Parsing ${pdfDocuments.length} source document(s)`;

        log.info(sourceParsingMessage);
        logGenerationProgress(sourceParsingMessage);

        const documentTexts: Array<{
          fileName: string;
          text: string;
        }> = [];

        const parsedDocuments: Array<{
          fileName: string;
          fileSize: number;
          mimeType?: string;
          parsed: ParsedPdfContent;
          imageStartIndex: number;
          imageCount: number;
        }> = [];
        const images: Array<{
          id: string;
          src: string;
          pageNumber: number;
          description?: string;
          width?: number;
          height?: number;
          visualRegions?: PdfImage['visualRegions'];
        }> = [];

        let totalRawTextLength = 0;

        const recordParsedDocument = (
          fileName: string,
          fileSize: number,
          parsed: ParsedPdfContent,
          documentIndex: number,
          mimeType?: string,
        ) => {
          const documentText =
            parsed.text || '';

          totalRawTextLength +=
            documentText.length;

          documentTexts.push({
            fileName,
            text: documentText,
          });

          const rawPdfImages =
            parsed.metadata?.pdfImages;

          const documentImages: Array<{
            src: string;
            pageNumber: number;
            description?: string;
            width?: number;
            height?: number;
            visualRegions?: PdfImage['visualRegions'];
          }> =
            rawPdfImages
              ? rawPdfImages.map(
                  (img) => ({
                    src: img.src || '',
                    pageNumber:
                      img.pageNumber || 1,
                    description:
                      img.description,
                    width: img.width,
                    height: img.height,
                    visualRegions:
                      img.visualRegions,
                  }),
                )
              : (parsed.images || []).map(
                  (src) => ({
                    src,
                    pageNumber: 1,
                  }),
                );

          const documentImageStartIndex =
            images.length;

          for (const image of documentImages) {
            images.push({
              id: `img_${images.length + 1}`,
              src: image.src,
              pageNumber:
                image.pageNumber,
              description:
                image.description
                  ? `${image.description} [Source: ${fileName}]`
                  : `Source: ${fileName}`,
              width: image.width,
              height: image.height,
              visualRegions:
                image.visualRegions,
            });
          }

          parsedDocuments.push({
            fileName,
            fileSize,
            mimeType,
            parsed,
            imageStartIndex:
              documentImageStartIndex,
            imageCount:
              documentImages.length,
          });

          const parsedSourceMessage =
            `[Generation] Parsed source ${documentIndex + 1}: ` +
            `${fileName} ` +
            `(${documentText.length} chars, ${documentImages.length} images)`;

          log.info(parsedSourceMessage);
          logGenerationProgress(parsedSourceMessage);
        };

        // ------------------------------------------------------------
        // Direct textual source phase.
        //
        // TXT / Markdown / JSON / XML / CSV do not need MinerU or
        // unpdf. Read them directly from their original stored blobs.
        // They still normalize through the same ParsedPdfContent ->
        // SourceDocument adapter for now so the downstream generation
        // pipeline remains unchanged.
        // ------------------------------------------------------------

        const directDocuments =
          pdfDocuments.filter(
            (document) =>
              isDirectTextSource(
                document.fileName,
                document.mimeType,
              ),
          );

        if (directDocuments.length > 0) {
          const directPhaseMessage =
            `[Generation] Direct source phase: ${directDocuments.length} document(s)`;

          log.info(directPhaseMessage);
          logGenerationProgress(directPhaseMessage);

          for (
            let documentIndex = 0;
            documentIndex <
            directDocuments.length;
            documentIndex++
          ) {
            const document =
              directDocuments[
                documentIndex
              ];

            const sourceBlob =
              await loadPdfBlob(
                document.storageKey,
              );

            if (
              !sourceBlob ||
              !(sourceBlob instanceof Blob) ||
              sourceBlob.size === 0
            ) {
              throw new Error(
                `${t('generation.pdfLoadFailed')}: ${document.fileName}`,
              );
            }

            const rawText =
              await sourceBlob.text();

            const normalizedText =
              normalizeDirectSourceText(
                document.fileName,
                document.mimeType ||
                  sourceBlob.type,
                rawText,
              );

            const directParsed:
              ParsedPdfContent = {
                text: normalizedText,
                images: [],
                metadata: {
                  parser: 'direct-source',
                  fileSize:
                    sourceBlob.size,
                  pageCount: 1,
                },
              };

            recordParsedDocument(
              document.fileName,
              sourceBlob.size,
              directParsed,
              documentIndex,
              document.mimeType ||
                sourceBlob.type ||
                'text/plain',
            );
          }

          log.info(
            '[Generation] Direct source phase complete',
          );
          logGenerationProgress(
            '[Generation] Direct source phase complete',
          );
        }

        // ------------------------------------------------------------
        // DOCX source phase.
        //
        // DOCX is an OOXML ZIP package. Parse word/document.xml
        // locally with JSZip and DOMParser. MinerU is not involved.
        // ------------------------------------------------------------

        const docxDocuments =
          pdfDocuments.filter(
            (document) =>
              isDocxSource(
                document.fileName,
                document.mimeType,
              ),
          );

        if (
          docxDocuments.length > 0
        ) {
          const docxPhaseMessage =
            `[Generation] DOCX source phase: ${docxDocuments.length} document(s)`;

          log.info(
            docxPhaseMessage,
          );
          logGenerationProgress(
            docxPhaseMessage,
          );

          for (
            let documentIndex = 0;
            documentIndex <
            docxDocuments.length;
            documentIndex++
          ) {
            const document =
              docxDocuments[
                documentIndex
              ];

            const sourceBlob =
              await loadPdfBlob(
                document.storageKey,
              );

            if (
              !sourceBlob ||
              !(sourceBlob instanceof Blob) ||
              sourceBlob.size === 0
            ) {
              throw new Error(
                `${t('generation.pdfLoadFailed')}: ${document.fileName}`,
              );
            }

            const parsed =
              await parseDocxSource(
                sourceBlob,
                document.fileName,
                signal,
              );

            recordParsedDocument(
              document.fileName,
              sourceBlob.size,
              parsed,
              documentIndex,
              document.mimeType ||
                sourceBlob.type ||
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            );
          }

          log.info(
            '[Generation] DOCX source phase complete',
          );
          logGenerationProgress(
            '[Generation] DOCX source phase complete',
          );
        }

        // ------------------------------------------------------------
        // XLSX source phase.
        //
        // XLSX is an OOXML ZIP package. Parse workbook/sheet XML
        // directly with JSZip and DOMParser. No MinerU or vision is
        // required for ordinary spreadsheet cells.
        // ------------------------------------------------------------

        const xlsxDocuments =
          pdfDocuments.filter(
            (document) =>
              isXlsxSource(
                document.fileName,
                document.mimeType,
              ),
          );

        if (
          xlsxDocuments.length > 0
        ) {
          const xlsxPhaseMessage =
            `[Generation] XLSX source phase: ${xlsxDocuments.length} document(s)`;

          log.info(
            xlsxPhaseMessage,
          );

          logGenerationProgress(
            xlsxPhaseMessage,
          );

          for (
            let documentIndex = 0;
            documentIndex <
            xlsxDocuments.length;
            documentIndex++
          ) {
            const document =
              xlsxDocuments[
                documentIndex
              ];

            const sourceBlob =
              await loadPdfBlob(
                document.storageKey,
              );

            if (
              !sourceBlob ||
              !(sourceBlob instanceof Blob) ||
              sourceBlob.size === 0
            ) {
              throw new Error(
                `${t('generation.pdfLoadFailed')}: ${document.fileName}`,
              );
            }

            const parsed =
              await parseXlsxSource(
                sourceBlob,
                document.fileName,
                signal,
              );

            recordParsedDocument(
              document.fileName,
              sourceBlob.size,
              parsed,
              documentIndex,
              document.mimeType ||
                sourceBlob.type ||
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            );
          }

          log.info(
            '[Generation] XLSX source phase complete',
          );

          logGenerationProgress(
            '[Generation] XLSX source phase complete',
          );
        }

        // Only PDF/image-style sources continue into MinerU/unpdf.
        // The original session field is still named pdfDocuments for
        // backward compatibility during this migration.
        pdfDocuments =
          pdfDocuments.filter(
            (document) =>
              !isDirectTextSource(
                document.fileName,
                document.mimeType,
              ) &&
              !isDocxSource(
                document.fileName,
                document.mimeType,
              ) &&
              !isXlsxSource(
                document.fileName,
                document.mimeType,
              ),
          );

        if (
          pdfDocuments.length > 0 &&
          currentSession.pdfProviderId ===
          'mineru'
        ) {
          log.info(
            `[Generation] Using one local MinerU batch for ${pdfDocuments.length} PDF document(s)`,
          );

          const mineruFormData =
            new FormData();

          const mineruFileSizes:
            number[] = [];

          const mineruMimeTypes:
            Array<string | undefined> = [];

          for (
            let documentIndex = 0;
            documentIndex <
            pdfDocuments.length;
            documentIndex++
          ) {
            const document =
              pdfDocuments[
                documentIndex
              ];

            const pdfBlob =
              await loadPdfBlob(
                document.storageKey,
              );

            if (!pdfBlob) {
              throw new Error(
                `${t('generation.pdfLoadFailed')}: ${document.fileName}`,
              );
            }

            if (
              !(pdfBlob instanceof Blob) ||
              pdfBlob.size === 0
            ) {
              throw new Error(
                `${t('generation.pdfLoadFailed')}: ${document.fileName}`,
              );
            }

            mineruFileSizes.push(
              pdfBlob.size,
            );

            const sourceMimeType =
              document.mimeType ||
              pdfBlob.type ||
              (document.fileName
                .toLowerCase()
                .endsWith('.pdf')
                ? 'application/pdf'
                : 'application/octet-stream');

            mineruMimeTypes.push(
              sourceMimeType,
            );

            const sourceFile =
              new File(
                [pdfBlob],
                document.fileName,
                {
                  type:
                    sourceMimeType,
                },
              );

            mineruFormData.append(
              'sources',
              sourceFile,
              document.fileName,
            );
          }

          const parseResponse =
            await fetch(
              '/api/parse-pdf/mineru-batch',
              {
                method: 'POST',
                body: mineruFormData,
                signal,
              },
            );

          if (!parseResponse.ok) {
            const errorData =
              await parseResponse.json();

            throw new Error(
              errorData.error ||
                t(
                  'generation.pdfParseFailed',
                ),
            );
          }

          const parseResult =
            await parseResponse.json();

          const batchResults =
            Array.isArray(
              parseResult?.data?.data,
            )
              ? parseResult.data.data
              : Array.isArray(
                    parseResult?.data,
                  )
                ? parseResult.data
                : [];

          if (
            batchResults.length !==
            pdfDocuments.length
          ) {
            throw new Error(
              `MinerU returned ${batchResults.length} document(s), ` +
                `but ${pdfDocuments.length} were submitted`,
            );
          }

          for (
            let documentIndex = 0;
            documentIndex <
            batchResults.length;
            documentIndex++
          ) {
            const result =
              batchResults[
                documentIndex
              ];

            const parsed =
              result?.data as
                | ParsedPdfContent
                | undefined;

            if (!parsed) {
              throw new Error(
                `${pdfDocuments[documentIndex].fileName}: ` +
                  t(
                    'generation.pdfParseFailed',
                  ),
              );
            }

            recordParsedDocument(
              pdfDocuments[
                documentIndex
              ].fileName,
              mineruFileSizes[
                documentIndex
              ],
              parsed,
              documentIndex,
              mineruMimeTypes[
                documentIndex
              ],
            );
          }
        } else {
          for (
            let documentIndex = 0;
            documentIndex <
            pdfDocuments.length;
            documentIndex++
          ) {
            const document =
              pdfDocuments[
                documentIndex
              ];

            log.info(
              `[Generation] Parsing source ${documentIndex + 1}/${pdfDocuments.length}: ${document.fileName}`,
            );

            const pdfBlob =
              await loadPdfBlob(
                document.storageKey,
              );

            if (!pdfBlob) {
              throw new Error(
                `${t('generation.pdfLoadFailed')}: ${document.fileName}`,
              );
            }

            if (
              !(pdfBlob instanceof Blob) ||
              pdfBlob.size === 0
            ) {
              throw new Error(
                `${t('generation.pdfLoadFailed')}: ${document.fileName}`,
              );
            }

            const pdfFile =
              new File(
                [pdfBlob],
                document.fileName,
                {
                  type:
                    'application/pdf',
                },
              );

            const parseFormData =
              new FormData();

            parseFormData.append(
              'pdf',
              pdfFile,
              document.fileName,
            );

            if (
              currentSession.pdfProviderId
            ) {
              parseFormData.append(
                'providerId',
                currentSession.pdfProviderId,
              );
            }

            if (
              currentSession
                .pdfProviderConfig
                ?.apiKey?.trim()
            ) {
              parseFormData.append(
                'apiKey',
                currentSession
                  .pdfProviderConfig
                  .apiKey,
              );
            }

            if (
              currentSession
                .pdfProviderConfig
                ?.baseUrl?.trim()
            ) {
              parseFormData.append(
                'baseUrl',
                currentSession
                  .pdfProviderConfig
                  .baseUrl,
              );
            }

            const parseResponse =
              await fetch(
                '/api/parse-pdf',
                {
                  method: 'POST',
                  body: parseFormData,
                  signal,
                },
              );

            if (!parseResponse.ok) {
              const errorData =
                await parseResponse.json();

              throw new Error(
                `${document.fileName}: ` +
                  (errorData.error ||
                    t(
                      'generation.pdfParseFailed',
                    )),
              );
            }

            const parseResult =
              await parseResponse.json();

            if (
              !parseResult.success ||
              !parseResult.data
            ) {
              throw new Error(
                `${document.fileName}: ${t(
                  'generation.pdfParseFailed',
                )}`,
              );
            }

            recordParsedDocument(
              document.fileName,
              pdfBlob.size,
              parseResult.data as
                ParsedPdfContent,
              documentIndex,
              'application/pdf',
            );
          }
        }

        const fullPdfText =
          documentTexts
            .map(
              ({ fileName, text }) =>
                `===== SOURCE: ${fileName} =====\n${text}`,
            )
            .join('\n\n');

        let pdfText = fullPdfText;
        let textWasTruncated = false;

        if (
          pdfText.length >
          MAX_SOURCE_TEXT_CHARS
        ) {
          textWasTruncated = true;

          const headerBudget =
            documentTexts.reduce(
              (total, document) =>
                total +
                `===== SOURCE: ${document.fileName} =====\n\n`
                  .length,
              0,
            );

          const bodyBudget =
            Math.max(
              0,
              MAX_SOURCE_TEXT_CHARS -
                headerBudget,
            );

          const perDocumentBudget =
            Math.floor(
              bodyBudget /
                Math.max(
                  1,
                  documentTexts.length,
                ),
            );

          pdfText =
            documentTexts
              .map(
                ({ fileName, text }) =>
                  `===== SOURCE: ${fileName} =====\n` +
                  text.substring(
                    0,
                    perDocumentBudget,
                  ),
              )
              .join('\n\n')
              .substring(
                0,
                MAX_SOURCE_TEXT_CHARS,
              );
        }

        const imageStorageIds =
          await storeImages(images);

        const imageStorageIdByImageId = new Map<string, string>();

        images.forEach((image, index) => {
          const storageId = imageStorageIds[index];

          if (storageId) {
            imageStorageIdByImageId.set(image.id, storageId);
          }
        });

        const sourceDocumentRefs = await Promise.all(
          parsedDocuments.map(async (parsedDocument) => {
            const documentImageStorageIds = Array.from(
              { length: parsedDocument.imageCount },
              (_, imageOffset) => {
                const globalImageId =
                  `img_${parsedDocument.imageStartIndex + imageOffset + 1}`;

                return imageStorageIdByImageId.get(globalImageId);
              },
            );

            const sourceDocument = sourceDocumentFromParsedPdf(
              parsedDocument.parsed,
              {
                id: `source_${nanoid(10)}`,
                fileName: parsedDocument.fileName,
                mimeType: parsedDocument.mimeType ?? 'application/pdf',
                fileSize: parsedDocument.fileSize,
                imageStorageIds: documentImageStorageIds,
              },
            );

            return storeSourceDocument(
              currentSession.sessionId,
              sourceDocument,
            );
          }),
        );

        const sourceStorageMessage =
          `[Generation] Stored ${sourceDocumentRefs.length} complete source document(s) in IndexedDB`;

        log.info(sourceStorageMessage);
        logGenerationProgress(sourceStorageMessage);
        const pdfImages: PdfImage[] =
          images.map(
            (img, i) => ({
              id: img.id,
              src: '',
              pageNumber: img.pageNumber,
              description: img.description,
              width: img.width,
              height: img.height,
              visualRegions:
                img.visualRegions,
              storageId:
                imageStorageIds[i],
            }),
          );

        const updatedSession = {
          ...currentSession,
          sourceDocumentRefs,
          pdfText,
          pdfImages,
          imageStorageIds,

          pdfDocuments: undefined,

          // Legacy singular fields are cleared as well.
          pdfStorageKey: undefined,
          pdfFileName: undefined,
        };

        setSession(updatedSession);

        sessionStorage.setItem(
          'generationSession',
          JSON.stringify(updatedSession),
        );

        const warnings: string[] = [];

        if (textWasTruncated) {
          warnings.push(
            t('generation.textTruncated').replace(
              '{n}',
              String(MAX_SOURCE_TEXT_CHARS),
            ),
          );
        }

        if (
          images.length >
          MAX_VISION_IMAGES
        ) {
          warnings.push(
            t('generation.imageTruncated')
              .replace(
                '{total}',
                String(images.length),
              )
              .replace(
                '{max}',
                String(MAX_VISION_IMAGES),
              ),
          );
        }

        if (warnings.length > 0) {
          setTruncationWarnings(warnings);
        }

        const sourceAnalysisMessage =
          `[Generation] Source analysis complete: ` +
          `${parsedDocuments.length} documents, ` +
          `${totalRawTextLength} raw text chars, ` +
          `${images.length} images`;

        log.info(sourceAnalysisMessage);
        logGenerationProgress(sourceAnalysisMessage);

        currentSession =
          updatedSession;

        activeSteps =
          getActiveSteps(currentSession);
      }

      // Step: Web Search (if enabled)
      const webSearchStepIdx = activeSteps.findIndex((s) => s.id === 'web-search');
      if (currentSession.requirements.webSearch && webSearchStepIdx >= 0) {
        setCurrentStepIndex(webSearchStepIdx);
        setWebSearchSources([]);

        const wsSettings = useSettingsStore.getState();
        const wsApiKey =
          wsSettings.webSearchProvidersConfig?.[wsSettings.webSearchProviderId]?.apiKey;
        const res = await fetch('/api/web-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: currentSession.requirements.requirement,
            apiKey: wsApiKey || undefined,
          }),
          signal,
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: 'Web search failed' }));
          throw new Error(data.error || t('generation.webSearchFailed'));
        }

        const searchData = await res.json();
        const sources = (searchData.sources || []).map((s: { title: string; url: string }) => ({
          title: s.title,
          url: s.url,
        }));
        setWebSearchSources(sources);

        const updatedSessionWithSearch = {
          ...currentSession,
          researchContext: searchData.context || '',
          researchSources: sources,
        };
        setSession(updatedSessionWithSearch);
        sessionStorage.setItem('generationSession', JSON.stringify(updatedSessionWithSearch));
        currentSession = updatedSessionWithSearch;
        activeSteps = getActiveSteps(currentSession);
      }

      // Load imageMapping early (needed for both outline and scene generation)
      let imageMapping: ImageMapping = {};
      if (currentSession.imageStorageIds && currentSession.imageStorageIds.length > 0) {
        log.debug('Loading images from IndexedDB');
        imageMapping = await loadImageMapping(currentSession.imageStorageIds);
      } else if (
        currentSession.imageMapping &&
        Object.keys(currentSession.imageMapping).length > 0
      ) {
        log.debug('Using imageMapping from session (old format)');
        imageMapping = currentSession.imageMapping;
      }

      // ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Agent generation (before outlines so persona can influence structure) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
      const settings = useSettingsStore.getState();
      let agents: Array<{
        id: string;
        name: string;
        role: string;
        persona?: string;
      }> = [];

      // Stage was created before source parsing so its durable history
      // record exists even when generation fails early.

      if (settings.agentMode === 'auto') {
        const agentStepIdx = activeSteps.findIndex((s) => s.id === 'agent-generation');
        if (agentStepIdx >= 0) setCurrentStepIndex(agentStepIdx);

        try {
          const allAvatars = [
            '/avatars/assist.png',
            '/avatars/assist-2.png',
            '/avatars/clown.png',
            '/avatars/clown-2.png',
            '/avatars/curious.png',
            '/avatars/curious-2.png',
            '/avatars/note-taker.png',
            '/avatars/note-taker-2.png',
            '/avatars/teacher.png',
            '/avatars/teacher-2.png',
            '/avatars/thinker.png',
            '/avatars/thinker-2.png',
          ];

          // No outlines yet ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â agent generation uses only stage name + description
          const agentResp = await fetch('/api/generate/agent-profiles', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify({
              stageInfo: { name: stage.name, description: stage.description },
              language: currentSession.requirements.language || 'en-US',
              availableAvatars: allAvatars,
            }),
            signal,
          });

          if (!agentResp.ok) throw new Error('Agent generation failed');
          const agentData = await agentResp.json();
          if (!agentData.success) throw new Error(agentData.error || 'Agent generation failed');

          // Save to IndexedDB and registry
          const { saveGeneratedAgents } = await import('@/lib/orchestration/registry/store');
          const savedIds = await saveGeneratedAgents(stage.id, agentData.agents);
          settings.setSelectedAgentIds(savedIds);

          // Show card-reveal modal without blocking generation.
          setGeneratedAgents(agentData.agents);
          setShowAgentReveal(true);

          agents = savedIds
            .map((id) => useAgentRegistry.getState().getAgent(id))
            .filter(Boolean)
            .map((a) => ({
              id: a!.id,
              name: a!.name,
              role: a!.role,
              persona: a!.persona,
            }));
        } catch (err: unknown) {
          log.warn('[Generation] Agent generation failed, falling back to presets:', err);
          const registry = useAgentRegistry.getState();
          agents = settings.selectedAgentIds
            .map((id) => registry.getAgent(id))
            .filter(Boolean)
            .map((a) => ({
              id: a!.id,
              name: a!.name,
              role: a!.role,
              persona: a!.persona,
            }));
        }
      } else {
        // Preset mode ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â use selected agents (include persona)
        const registry = useAgentRegistry.getState();
        agents = settings.selectedAgentIds
          .map((id) => registry.getAgent(id))
          .filter(Boolean)
          .map((a) => ({
            id: a!.id,
            name: a!.name,
            role: a!.role,
            persona: a!.persona,
          }));
      }

      // ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Generate outlines (with agent personas for teacher context) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
      let outlines = currentSession.sceneOutlines;

      const outlineStepIdx = activeSteps.findIndex((s) => s.id === 'outline');
      setCurrentStepIndex(outlineStepIdx >= 0 ? outlineStepIdx : 0);
      if (!outlines || outlines.length === 0) {
        log.debug('=== Generating outlines (SSE) ===');
        setStreamingOutlines([]);

        outlines = await new Promise<SceneOutline[]>((resolve, reject) => {
          const collected: SceneOutline[] = [];

          fetch('/api/generate/scene-outlines-stream', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify({
              requirements: currentSession.requirements,
              pdfText: currentSession.pdfText,
              pdfImages: currentSession.pdfImages,
              imageMapping,
              researchContext: currentSession.researchContext,
              agents,
            }),
            signal,
          })
            .then((res) => {
              if (!res.ok) {
                return res.json().then((d) => {
                  reject(new Error(d.error || t('generation.outlineGenerateFailed')));
                });
              }

              const reader = res.body?.getReader();
              if (!reader) {
                reject(new Error(t('generation.streamNotReadable')));
                return;
              }

              const decoder = new TextDecoder();
              let sseBuffer = '';

              const pump = (): Promise<void> =>
                reader.read().then(({ done, value }) => {
                  if (value) {
                    sseBuffer += decoder.decode(value, { stream: !done });
                    const lines = sseBuffer.split('\n');
                    sseBuffer = lines.pop() || '';

                    for (const line of lines) {
                      if (!line.startsWith('data: ')) continue;
                      try {
                        const evt = JSON.parse(line.slice(6));
                        if (evt.type === 'outline') {
                          collected.push(evt.data);
                          setStreamingOutlines([...collected]);
                        } else if (evt.type === 'retry') {
                          collected.length = 0;
                          setStreamingOutlines([]);
                          setStatusMessage(t('generation.outlineRetrying'));
                        } else if (evt.type === 'done') {
                          resolve(evt.outlines || collected);
                          return;
                        } else if (evt.type === 'error') {
                          reject(new Error(evt.error));
                          return;
                        }
                      } catch (e) {
                        log.error('Failed to parse outline SSE:', line, e);
                      }
                    }
                  }
                  if (done) {
                    if (collected.length > 0) {
                      resolve(collected);
                    } else {
                      reject(new Error(t('generation.outlineEmptyResponse')));
                    }
                    return;
                  }
                  return pump();
                });

              pump().catch(reject);
            })
            .catch(reject);
        });

        const updatedSession = { ...currentSession, sceneOutlines: outlines };
        setSession(updatedSession);
        sessionStorage.setItem('generationSession', JSON.stringify(updatedSession));

        // Outline generation succeeded ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â clear homepage draft cache
        try {
          localStorage.removeItem('requirementDraft');
        } catch {
          /* ignore */
        }

        // Brief pause to let user see the final outline state
        await new Promise((resolve) => setTimeout(resolve, 800));
      }

      // Move to scene generation step
      setStatusMessage('');
      if (!outlines || outlines.length === 0) {
        throw new Error(t('generation.outlineEmptyResponse'));
      }

      const plannedImageCount = outlines.reduce(
        (count, outline) =>
          count +
          (outline.mediaGenerations?.filter((request) => request.type === 'image').length ?? 0),
        0,
      );

      const plannedVideoCount = outlines.reduce(
        (count, outline) =>
          count +
          (outline.mediaGenerations?.filter((request) => request.type === 'video').length ?? 0),
        0,
      );

      logGenerationProgress(`[Generation] Outline complete: ${outlines.length} slides planned`);
      logGenerationProgress(`[Generation] Images planned: ${plannedImageCount}`);
      logGenerationProgress(`[Generation] Videos planned: ${plannedVideoCount}`);

      // Store stage and outlines
      const store = useStageStore.getState();
      store.setStage(stage);
      store.setOutlines(outlines);

      // Advance to slide-content step
      const contentStepIdx = activeSteps.findIndex((s) => s.id === 'slide-content');
      if (contentStepIdx >= 0) setCurrentStepIndex(contentStepIdx);

      // Build stageInfo and userProfile for API call
      const stageInfo = {
        name: stage.name,
        description: stage.description,
        language: stage.language,
        style: stage.style,
      };

      const userProfile =
        currentSession.requirements.userNickname || currentSession.requirements.userBio
          ? `Student: ${currentSession.requirements.userNickname || 'Unknown'}${currentSession.requirements.userBio ? ` ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ${currentSession.requirements.userBio}` : ''}`
          : undefined;

      // Generate ONLY the first scene
      store.setGeneratingOutlines(outlines);

      const firstOutline = outlines[0];

      logGenerationProgress(
        `[Generation] Generating slide 1 of ${outlines.length}: ${firstOutline.title}`,
      );

      // Step 2: Generate content (currentStepIndex is already 2)
      const contentResp = await fetch('/api/generate/scene-content', {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
          outline: firstOutline,
          allOutlines: outlines,
          pdfImages: currentSession.pdfImages,
          sourceEvidence: currentSession.pdfText,
          classRequirement: currentSession.requirements.requirement,
          imageMapping,
          stageInfo,
          stageId: stage.id,
          agents,
        }),
        signal,
      });

      if (!contentResp.ok) {
        const errorData = await contentResp.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(errorData.error || t('generation.sceneGenerateFailed'));
      }

      const contentData = await contentResp.json();
      if (!contentData.success || !contentData.content) {
        throw new Error(contentData.error || t('generation.sceneGenerateFailed'));
      }

      // Generate actions (activate actions step indicator)
      const actionsStepIdx = activeSteps.findIndex((s) => s.id === 'actions');
      setCurrentStepIndex(actionsStepIdx >= 0 ? actionsStepIdx : currentStepIndex + 1);

      const actionsResp = await fetch('/api/generate/scene-actions', {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
          outline: contentData.effectiveOutline || firstOutline,
          allOutlines: outlines,
          content: contentData.content,
          sourceEvidence: currentSession.pdfText,
          stageId: stage.id,
          agents,
          previousSpeeches: [],
          userProfile,
        }),
        signal,
      });

      if (!actionsResp.ok) {
        const errorData = await actionsResp.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(errorData.error || t('generation.sceneGenerateFailed'));
      }

      const data = await actionsResp.json();
      if (!data.success || !data.scene) {
        throw new Error(data.error || t('generation.sceneGenerateFailed'));
      }

      // Add the first completed scene.
      store.addScene(data.scene);
      store.setCurrentSceneId(data.scene.id);

      logGenerationProgress(
        `[Generation] Completed slide 1 of ${outlines.length}: ${firstOutline.title}`,
      );

      // Mark the remaining outlines as pending.
      const remaining = outlines.filter((o) => o.order !== data.scene.order);
      store.setGeneratingOutlines(remaining);

      // Generate every remaining scene before entering the classroom.
      if (remaining.length > 0) {
        await generateRemaining({
          pdfImages: currentSession.pdfImages,
          sourceEvidence: currentSession.pdfText,
          classRequirement: currentSession.requirements.requirement,
          imageMapping,
          stageInfo,
          agents,
          userProfile,
        });
      } else {
        store.setGenerationStatus('completed');
        store.setGeneratingOutlines([]);
      }

      // generateRemaining() pauses rather than throwing for some generation failures,
      // so explicitly verify that every outline became a completed scene.
      const finalState = useStageStore.getState();

      if (
        finalState.generationStatus !== 'completed' ||
        finalState.failedOutlines.length > 0 ||
        finalState.scenes.length !== outlines.length
      ) {
        throw new Error(
          `Full class generation did not complete: ${finalState.scenes.length}/${outlines.length} scenes generated`,
        );
      }

      // All LLM-dependent class generation is complete. Release the local
      // Ollama model before starting heavy media generation.
      try {
        const unloadResponse = await fetch('/api/unload-local-llm', {
          method: 'POST',
          signal,
        });

        if (!unloadResponse.ok) {
          log.warn('[Generation] Local LLM unload returned status', unloadResponse.status);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err;
        }
        log.warn('[Generation] Failed to unload local LLM before media generation:', err);
      }

      // ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Dedicated TTS phase ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
      // All LLM work is complete, so Ollama has been unloaded before starting
      // Docker/Kokoro. This keeps the two heavyweight services from competing
      // for unified memory during class generation.
      if (settings.ttsEnabled && settings.ttsProviderId !== 'browser-native-tts') {
        log.info('[Generation] Starting local speech services for TTS phase');

        const startSpeechResponse = await fetch('/api/local-speech-services', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start' }),
          signal,
        });

        const startSpeechData = await startSpeechResponse.json();

        if (!startSpeechResponse.ok || !startSpeechData.success) {
          throw new Error(
            startSpeechData.error || 'Failed to start local speech services for TTS generation',
          );
        }

        const scenesForTTS = [...useStageStore.getState().scenes].sort((a, b) => a.order - b.order);

        log.info(`[Generation] TTS phase: ${scenesForTTS.length} slides to generate`);

        for (let index = 0; index < scenesForTTS.length; index++) {
          if (signal.aborted) {
            throw new DOMException('Generation aborted', 'AbortError');
          }

          const scene = scenesForTTS[index];

          log.info(`[Generation] Generating TTS for slide ${index + 1} of ${scenesForTTS.length}`);

          const ttsResult = await generateTTSForScene(scene, signal);

          if (!ttsResult.success) {
            throw new Error(
              ttsResult.error ||
                `TTS generation failed for slide ${index + 1} of ${scenesForTTS.length}`,
            );
          }

          log.info(`[Generation] Completed TTS for slide ${index + 1} of ${scenesForTTS.length}`);
        }

        log.info(`[Generation] TTS phase complete: ${scenesForTTS.length} slides`);
      }

      // Media is a separate phase. Do not generate images/videos while the
      // LLM, Kokoro, or Whisper services are consuming memory.
      const hasImageRequests = outlines.some((outline) =>
        outline.mediaGenerations?.some((request) => request.type === 'image'),
      );

      const hasVideoRequests = outlines.some((outline) =>
        outline.mediaGenerations?.some((request) => request.type === 'video'),
      );

      const hasHeavyMedia =
        (settings.imageGenerationEnabled && hasImageRequests) ||
        (settings.videoGenerationEnabled && hasVideoRequests);

      let speechServicesStoppedForMedia = false;

      if (hasHeavyMedia) {
        const stopSpeechResponse = await fetch('/api/local-speech-services', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop' }),
          signal,
        });

        const stopSpeechData = await stopSpeechResponse.json();

        if (!stopSpeechResponse.ok || !stopSpeechData.success) {
          throw new Error(
            stopSpeechData.error || 'Failed to stop local speech services before media generation',
          );
        }

        speechServicesStoppedForMedia = true;
      }
      const runtimeProfileResponse = await fetch('/api/local-runtime-profile', {
        signal,
      });
      if (!runtimeProfileResponse.ok) {
        throw new Error('Failed to load local runtime profile');
      }
      const runtimeProfile = (await runtimeProfileResponse.json()) as {
        image?: {
          backend?: 'vmlx' | 'comfyui' | 'none';
          available?: boolean;
        };
        video?: { backend?: 'vmlx' | 'comfyui' | 'none'; available?: boolean };
        speech?: { backend?: 'docker' | 'none'; available?: boolean };
      };

      const imageBackend = runtimeProfile.image?.backend ?? 'none';
      const videoBackend = runtimeProfile.video?.backend ?? 'none';

      const imageUsesComfyUi =
        settings.imageGenerationEnabled &&
        hasImageRequests &&
        settings.imageProviderId === 'comfyui' &&
        imageBackend === 'comfyui';

      const videoUsesComfyUi =
        settings.videoGenerationEnabled &&
        hasVideoRequests &&
        settings.videoProviderId === 'comfyui' &&
        videoBackend === 'comfyui';

      let comfyUiStartedForMedia = false;

      const ensureComfyUiStarted = async () => {
        if (comfyUiStartedForMedia) return;

        log.info('[Generation] Starting local ComfyUI media service');

        const startResponse = await fetch('/api/local-comfyui', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start' }),
          signal,
        });

        const startData = await startResponse.json();

        if (!startResponse.ok || !startData.success) {
          throw new Error(startData.error || 'Failed to start local ComfyUI media service');
        }

        comfyUiStartedForMedia = true;

        log.info('[Generation] Local ComfyUI media service is ready');
      };

      const ensureComfyUiStopped = async () => {
        if (!comfyUiStartedForMedia) return;

        log.info('[Generation] Stopping local ComfyUI media service');

        const stopResponse = await fetch('/api/local-comfyui', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop' }),
        });

        const stopData = await stopResponse.json().catch(() => ({
          success: false,
          error: 'Invalid local ComfyUI stop response',
        }));

        if (!stopResponse.ok || !stopData.success) {
          throw new Error(
            stopData.error ||
              'Failed to confirm local ComfyUI media service shutdown',
          );
        }

        comfyUiStartedForMedia = false;

        log.info('[Generation] Local ComfyUI media service stopped');
      };

      logGenerationProgress(
        `[Generation] Runtime profile loaded: image=${imageBackend}, video=${videoBackend}`,
      );

      try {
        // Generate images as their own heavyweight phase.
        if (settings.imageGenerationEnabled && hasImageRequests) {
          if (imageUsesComfyUi) {
            await ensureComfyUiStarted();
          }

          const localImageService =
            settings.imageProviderId === 'local-mlx' && imageBackend === 'vmlx'
              ? {
                  name: 'vMLX',
                  endpoint: '/api/local-vmlx',
                }
              : null;

          if (localImageService) {
            log.info(`[Generation] Starting local ${localImageService.name} image service`);

            const startResponse = await fetch(localImageService.endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'start' }),
              signal,
            });

            const startData = await startResponse.json();

            if (!startResponse.ok || !startData.success) {
              throw new Error(
                startData.error || `Failed to start local ${localImageService.name} image service`,
              );
            }
          }

          try {
            await generateMediaForOutlines(outlines, stage.id, signal, 'image');
          } finally {
            if (localImageService) {
              try {
                log.info(`[Generation] Stopping local ${localImageService.name} image service`);

                const stopResponse = await fetch(localImageService.endpoint, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'stop' }),
                });

                const stopData = await stopResponse.json().catch(() => ({
                  success: false,
                  error: `Invalid ${localImageService.name} stop response`,
                }));

                if (!stopResponse.ok || !stopData.success) {
                  throw new Error(
                    stopData.error ||
                      `Failed to confirm local ${localImageService.name} image service shutdown`,
                  );
                }
              } catch (err) {
                log.error(
                  `[Generation] Failed to stop local ${localImageService.name} image service:`,
                  err,
                );
                throw err;
              }
            }
          }
        }

        // Videos are a separate phase and must not run while vMLX is resident.
        if (settings.videoGenerationEnabled && hasVideoRequests) {
          if (videoUsesComfyUi) {
            await ensureComfyUiStarted();
          }

          await generateMediaForOutlines(outlines, stage.id, signal, 'video');
        }

        // ------------------------------------------------------------
        // Generated-diagram annotation phase.
        //
        // Heavyweight lifecycle rule:
        //   media backend -> STOP -> Qwen-VL -> UNLOAD -> speech restore
        //
        // Never begin vision localization until local media services have
        // been confirmed stopped.
        // ------------------------------------------------------------

        await ensureComfyUiStopped();

        const diagramRequests =
          outlines.flatMap((outline) =>
            (outline.mediaGenerations || [])
              .filter(
                (
                  request,
                ): request is MediaGenerationRequest =>
                  request.type === 'image' &&
                  request.annotationRequest?.mode === 'diagram' &&
                  request.annotationRequest.features.length > 0,
              ),
          );

        if (diagramRequests.length > 0) {
          const mediaStore =
            useMediaGenerationStore.getState();

          const localizationInputs: Array<{
            key: string;
            imageId: string;
            sourceFileName: string;
            src: string;
            features: NonNullable<
              MediaGenerationRequest['annotationRequest']
            >['features'];
          }> = [];

          for (const request of diagramRequests) {
            if (signal.aborted) {
              throw new DOMException(
                'Generation aborted',
                'AbortError',
              );
            }

            const task =
              mediaStore.getTask(
                request.elementId,
              );

            if (
              task?.status !== 'done' ||
              !task.objectUrl
            ) {
              log.warn(
                `[Generation] Skipping diagram localization for ${request.elementId}: generated image is not ready`,
              );
              continue;
            }

            const src =
              await objectUrlToDataUrl(
                task.objectUrl,
              );

            localizationInputs.push({
              key:
                request.elementId,
              imageId:
                request.elementId,
              sourceFileName:
                request.elementId,
              src,
              features:
                request.annotationRequest!.features,
            });
          }

          if (
            localizationInputs.length > 0
          ) {
            logGenerationProgress(
              `[Generation] Diagram localization phase: ${localizationInputs.length} image${localizationInputs.length === 1 ? '' : 's'}`,
            );

            const localizationResponse =
              await fetch(
                '/api/local-vision/localize',
                {
                  method: 'POST',
                  headers: {
                    'Content-Type':
                      'application/json',
                  },
                  body:
                    JSON.stringify({
                      images:
                        localizationInputs,
                    }),
                  signal,
                },
              );

            const localizationData =
              (await localizationResponse.json()) as {
                success?: boolean;
                error?: string;
                results?: Array<{
                  key: string;
                  regions: LocalizedVisualRegion[];
                  model?: string;
                }>;
              };

            if (
              !localizationResponse.ok ||
              !localizationData.success
            ) {
              throw new Error(
                localizationData.error ||
                  'Generated-diagram localization failed',
              );
            }

            const resultMap =
              new Map(
                (
                  localizationData.results ||
                  []
                ).map(
                  (result) => [
                    result.key,
                    result.regions,
                  ],
                ),
              );

            for (
              const request of
              diagramRequests
            ) {
              const annotationRequest =
                request.annotationRequest;

              if (
                !annotationRequest
              ) {
                continue;
              }

              const regions =
                resultMap.get(
                  request.elementId,
                );

              if (
                !regions ||
                regions.length === 0
              ) {
                log.warn(
                  `[Generation] Vision localized no requested diagram features for ${request.elementId}`,
                );
                continue;
              }

              const stageStore =
                useStageStore.getState();

              const scene =
                stageStore.scenes.find(
                  (candidate) =>
                    candidate.type === 'slide' &&
                    candidate.content.type === 'slide' &&
                    candidate.content.canvas.elements.some(
                      (element) =>
                        element.type === 'image' &&
                        element.src === request.elementId,
                    ),
                );

              if (!scene) {
                log.warn(
                  `[Generation] Could not find slide containing generated image ${request.elementId}`,
                );
                continue;
              }

              const updatedScene =
                applyDiagramAnnotationsToScene(
                  scene,
                  request.elementId,
                  annotationRequest,
                  regions,
                );

              if (!updatedScene) {
                log.warn(
                  `[Generation] Could not apply native annotations for ${request.elementId}`,
                );
                continue;
              }

              stageStore.updateScene(
                scene.id,
                {
                  content:
                    updatedScene.content,
                  updatedAt:
                    updatedScene.updatedAt,
                },
              );

              log.info(
                `[Generation] Added native diagram annotations for ${request.elementId}`,
              );
            }

            logGenerationProgress(
              '[Generation] Diagram localization and native annotation phase complete',
            );
          }
        }
      } finally {
        // The classroom needs Kokoro for live speech and Whisper for microphone
        // input. Restore them even if media generation fails.

        if (comfyUiStartedForMedia) {
          // Safety requirement: do not restore another local AI service while
          // ComfyUI is still resident. A failed shutdown is a generation error.
          await ensureComfyUiStopped();
        }

        if (speechServicesStoppedForMedia) {
          try {
            const startSpeechResponse = await fetch('/api/local-speech-services', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'start' }),
            });

            const startSpeechData = await startSpeechResponse.json();

            if (!startSpeechResponse.ok || !startSpeechData.success) {
              throw new Error(
                startSpeechData.error || 'Failed to restore local speech services before classroom',
              );
            }
          } catch (err) {
            log.error('[Generation] Failed to restore local speech services:', err);
            throw err;
          }
        }
      }

      // Everything is complete. Persist the full class before navigating.
      setIsComplete(true);
      sessionStorage.removeItem('generationSession');
      sessionStorage.removeItem('generationParams');

      await finalState.saveToStorage();

      await persistGenerationState(
        'completed',
        {
          requireSuccess: true,
        },
      );

      // Briefly show the completed state before opening the classroom.
      await new Promise((resolve) => setTimeout(resolve, 800));

      router.push(`/classroom/${stage.id}`);
    } catch (err) {
      // Generation may fail before the normal post-LLM cleanup point.
      // Always make a best-effort attempt to release the local Ollama
      // model so a failed or cancelled classroom does not leave VRAM occupied.
      //
      // Do NOT pass the generation AbortSignal here: if generation was
      // cancelled, that signal may already be aborted and would prevent cleanup.
      try {
        const unloadResponse = await fetch('/api/unload-local-llm', {
          method: 'POST',
        });

        if (!unloadResponse.ok) {
          log.warn(
            '[Generation] Local LLM cleanup after failure returned status',
            unloadResponse.status,
          );
        } else {
          log.info('[Generation] Local LLM released after generation failure');
        }
      } catch (cleanupError) {
        log.warn(
          '[Generation] Failed to release local LLM after generation failure:',
          cleanupError,
        );
      }

      // AbortError is expected when navigating away ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â don't show as error
      const wasAborted =
        err instanceof DOMException &&
        err.name === 'AbortError';

      const errorMessage =
        wasAborted
          ? 'Generation cancelled before completion'
          : err instanceof Error
            ? err.message
            : String(err);

      if (wasAborted) {
        log.info(
          '[GenerationPreview] Generation aborted',
        );
      } else {
        log.error(
          '[Generation] Generation failed:',
          err,
        );
        logGenerationProgress(
          `[Generation] Generation failed: ${errorMessage}`,
        );
      }

      const failedState = useStageStore.getState();

      if (failedState.stage?.id === stage.id) {
        failedState.setGenerationStatus('error');
      }

      try {
        const diagnosticState =
          useStageStore.getState();

        const activeStep =
          activeSteps[
            Math.min(
              currentStepIndex,
              Math.max(
                0,
                activeSteps.length - 1,
              ),
            )
          ];

        const sourceFiles =
          currentSession.pdfDocuments?.map(
            (document) =>
              document.fileName,
          ) ||
          (
            currentSession.pdfFileName
              ? [
                  currentSession.pdfFileName,
                ]
              : []
          );

        const diagnosticResponse =
          await fetch(
            '/api/classroom/log',
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body:
                JSON.stringify({
                  classroomId:
                    stage.id,
                  timestamp:
                    new Date().toISOString(),
                  error: {
                    name:
                      err instanceof Error
                        ? err.name
                        : 'Error',
                    message:
                      errorMessage,
                    stack:
                      err instanceof Error
                        ? err.stack
                        : undefined,
                  },
                  requirement:
                    currentSession
                      .requirements
                      .requirement,
                  currentStepIndex,
                  currentStepId:
                    activeStep?.id,
                  currentStepLabel:
                    activeStep
                      ? t(activeStep.title)
                      : undefined,
                  statusMessage,
                  generationStatus:
                    diagnosticState
                      .generationStatus,
                  currentGeneratingOrder:
                    diagnosticState
                      .currentGeneratingOrder,
                  sceneCount:
                    diagnosticState
                      .scenes.length,
                  scenes:
                    diagnosticState
                      .scenes.map(
                        (scene) => ({
                          id:
                            scene.id,
                          order:
                            scene.order,
                          title:
                            scene.title,
                          type:
                            scene.content
                              ?.type,
                        }),
                      ),
                  outlineCount:
                    diagnosticState
                      .outlines.length,
                  outlines:
                    diagnosticState
                      .outlines.map(
                        (outline) => ({
                          id:
                            outline.id,
                          order:
                            outline.order,
                          title:
                            outline.title,
                        }),
                      ),
                  failedOutlines:
                    diagnosticState
                      .failedOutlines.map(
                        (outline) => ({
                          id:
                            outline.id,
                          order:
                            outline.order,
                          title:
                            outline.title,
                        }),
                      ),
                  generatingOutlines:
                    diagnosticState
                      .generatingOutlines.map(
                        (outline) => ({
                          id:
                            outline.id,
                          order:
                            outline.order,
                          title:
                            outline.title,
                        }),
                      ),
                  sourceFiles,
                  truncationWarnings,
                  userAgent:
                    navigator.userAgent,
                }),
            },
          );

        if (
          !diagnosticResponse.ok
        ) {
          log.warn(
            '[Generation] Failed to save classroom diagnostic log:',
            diagnosticResponse.status,
          );
        } else {
          log.info(
            `[Generation] Failure diagnostics saved for classroom ${stage.id}`,
          );
        }
      } catch (diagnosticError) {
        log.warn(
          '[Generation] Failed to save classroom diagnostic log:',
          diagnosticError,
        );
      }

      try {
        await persistGenerationState(
          'failed',
          {
            error: errorMessage,
          },
        );
      } catch (persistenceError) {
        log.warn(
          '[Generation] Failed to persist failed classroom history:',
          persistenceError,
        );
      }

      if (wasAborted) {
        return;
      }

      setError(errorMessage);
    }
  };

  const extractTopicFromRequirement = (requirement: string): string => {
    const trimmed = requirement.trim();
    if (trimmed.length <= 500) {
      return trimmed;
    }
    return trimmed.substring(0, 500).trim() + '...';
  };

  const goBackToHome = () => {
    abortControllerRef.current?.abort();
    stopSceneGeneration();
    sessionStorage.removeItem('generationSession');
    router.push('/');
  };

  // Still loading session from sessionStorage
  if (!sessionLoaded) {
    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <div className="text-center text-muted-foreground">
          <div className="size-8 border-2 border-current border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      </div>
    );
  }

  // No session found
  if (!session) {
    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <Card className="p-8 max-w-md w-full">
          <div className="text-center space-y-4">
            <AlertCircle className="size-12 text-muted-foreground mx-auto" />
            <h2 className="text-xl font-semibold">{t('generation.sessionNotFound')}</h2>
            <p className="text-sm text-muted-foreground">{t('generation.sessionNotFoundDesc')}</p>
            <Button onClick={() => router.push('/')} className="w-full">
              <ArrowLeft className="size-4 mr-2" />
              {t('generation.backToHome')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const activeStep =
    activeSteps.length > 0
      ? activeSteps[Math.min(currentStepIndex, activeSteps.length - 1)]
      : ALL_STEPS[0];

  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex flex-col items-center justify-center p-4 relative overflow-hidden text-center">
      {/* Background Decor */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div
          className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '4s' }}
        />
        <div
          className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '6s' }}
        />
      </div>

      {/* Back button */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="absolute top-4 left-4 z-20"
      >
        <Button variant="ghost" size="sm" onClick={goBackToHome}>
          <ArrowLeft className="size-4 mr-2" />
          {t('generation.backToHome')}
        </Button>
      </motion.div>

      <div className="z-10 w-full max-w-lg space-y-8 flex flex-col items-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="w-full"
        >
          <Card className="relative overflow-hidden border-muted/40 shadow-2xl bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl min-h-[400px] flex flex-col items-center justify-center p-8 md:p-12">
            {/* Progress Dots */}
            <div className="absolute top-6 left-0 right-0 flex justify-center gap-2">
              {activeSteps.map((step, idx) => (
                <div
                  key={step.id}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-500',
                    idx < currentStepIndex
                      ? 'w-1.5 bg-blue-500/30'
                      : idx === currentStepIndex
                        ? 'w-8 bg-blue-500'
                        : 'w-1.5 bg-muted/50',
                  )}
                />
              ))}
            </div>

            {/* Central Content */}
            <div className="flex-1 flex flex-col items-center justify-center w-full space-y-8 mt-4">
              {/* Icon / Visualizer Container */}
              <div className="relative size-48 flex items-center justify-center">
                <AnimatePresence mode="popLayout">
                  {error ? (
                    <motion.div
                      key="error"
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="size-32 rounded-full bg-red-500/10 flex items-center justify-center border-2 border-red-500/20"
                    >
                      <AlertCircle className="size-16 text-red-500" />
                    </motion.div>
                  ) : isComplete ? (
                    <motion.div
                      key="complete"
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="size-32 rounded-full bg-green-500/10 flex items-center justify-center border-2 border-green-500/20"
                    >
                      <CheckCircle2 className="size-16 text-green-500" />
                    </motion.div>
                  ) : (
                    <motion.div
                      key={activeStep.id}
                      initial={{ scale: 0.8, opacity: 0, filter: 'blur(10px)' }}
                      animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                      exit={{ scale: 1.2, opacity: 0, filter: 'blur(10px)' }}
                      transition={{ duration: 0.4 }}
                      className="absolute inset-0 flex items-center justify-center"
                    >
                      <StepVisualizer
                        stepId={activeStep.id}
                        outlines={streamingOutlines}
                        webSearchSources={webSearchSources}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Text Content */}
              <div className="space-y-3 max-w-sm mx-auto">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={error ? 'error' : isComplete ? 'done' : activeStep.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-2"
                  >
                    <h2 className="text-2xl font-bold tracking-tight">
                      {error
                        ? t('generation.generationFailed')
                        : isComplete
                          ? t('generation.generationComplete')
                          : t(activeStep.title)}
                    </h2>
                    <p className="text-muted-foreground text-base">
                      {error
                        ? error
                        : isComplete
                          ? t('generation.classroomReady')
                          : statusMessage || t(activeStep.description)}
                    </p>
                  </motion.div>
                </AnimatePresence>

                {/* Truncation warning indicator */}
                <AnimatePresence>
                  {truncationWarnings.length > 0 && !error && !isComplete && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0 }}
                      transition={{
                        type: 'spring',
                        stiffness: 500,
                        damping: 30,
                      }}
                      className="flex justify-center"
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <motion.button
                            type="button"
                            animate={{
                              boxShadow: [
                                '0 0 0 0 rgba(251, 191, 36, 0), 0 0 0 0 rgba(251, 191, 36, 0)',
                                '0 0 16px 4px rgba(251, 191, 36, 0.12), 0 0 4px 1px rgba(251, 191, 36, 0.08)',
                                '0 0 0 0 rgba(251, 191, 36, 0), 0 0 0 0 rgba(251, 191, 36, 0)',
                              ],
                            }}
                            transition={{
                              duration: 3,
                              repeat: Infinity,
                              ease: 'easeInOut',
                            }}
                            className="relative size-7 rounded-full flex items-center justify-center cursor-default
                                       bg-gradient-to-br from-amber-400/15 to-orange-400/10
                                       border border-amber-400/25 hover:border-amber-400/40
                                       hover:from-amber-400/20 hover:to-orange-400/15
                                       transition-colors duration-300
                                       focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30"
                          >
                            <AlertTriangle
                              className="size-3.5 text-amber-500 dark:text-amber-400"
                              strokeWidth={2.5}
                            />
                          </motion.button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" sideOffset={6}>
                          <div className="space-y-1 py-0.5">
                            {truncationWarnings.map((w, i) => (
                              <p key={i} className="text-xs leading-relaxed">
                                {w}
                              </p>
                            ))}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </Card>
        </motion.div>

        {/* Footer Action */}
        <div className="h-16 flex items-center justify-center w-full">
          <AnimatePresence>
            {error ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full max-w-xs"
              >
                <Button size="lg" variant="outline" className="w-full h-12" onClick={goBackToHome}>
                  {t('generation.goBackAndRetry')}
                </Button>
              </motion.div>
            ) : !isComplete ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-3 text-sm text-muted-foreground/50 font-medium uppercase tracking-widest"
              >
                <Sparkles className="size-3 animate-pulse" />
                {t('generation.aiWorking')}
                {generatedAgents.length > 0 && !showAgentReveal && (
                  <button
                    onClick={() => setShowAgentReveal(true)}
                    className="ml-2 flex items-center gap-1.5 rounded-full border border-purple-300/30 bg-purple-500/10 px-3 py-1 text-xs font-medium normal-case tracking-normal text-purple-400 transition-colors hover:bg-purple-500/20 hover:text-purple-300"
                  >
                    <Bot className="size-3" />
                    {t('generation.viewAgents')}
                  </button>
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {/* Agent Reveal Modal */}
      <AgentRevealModal
        agents={generatedAgents}
        open={showAgentReveal}
        onClose={() => setShowAgentReveal(false)}
        onAllRevealed={() => {
          agentRevealResolveRef.current?.();
          agentRevealResolveRef.current = null;
        }}
      />
    </div>
  );
}

export default function GenerationPreviewPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center">
          <div className="animate-pulse space-y-4 text-center">
            <div className="h-8 w-48 bg-muted rounded mx-auto" />
            <div className="h-4 w-64 bg-muted rounded mx-auto" />
          </div>
        </div>
      }
    >
      <GenerationPreviewContent />
    </Suspense>
  );
}
