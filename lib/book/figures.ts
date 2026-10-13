/**
 * Figure blocks inside book sections.
 *
 * The author model writes figures as fenced blocks:
 *   ```chart   {JSON chart spec}```   → rendered to SVG with ECharts (server side)
 *   ```mermaid %% caption: ...```     → rendered by Mermaid inside the PDF browser
 *   ```image   {"prompt","caption"}```→ generated with the image provider (ComfyUI)
 *
 * On save, chart/image JSON is repaired and normalised, image figures get a
 * stable id (used as the PNG file name), and figures that can't be rendered
 * are dropped so they never break the PDF.
 */
import { parseJsonResponse } from '@/lib/generation/json-repair';

export interface ChartSpec {
  type: 'bar' | 'line' | 'area' | 'scatter' | 'pie';
  title?: string;
  xLabel?: string;
  yLabel?: string;
  categories?: string[];
  series: Array<{ name?: string; data: Array<number | [number, number]> }>;
  caption?: string;
  source?: string;
}

export interface ImageSpec {
  id: string;
  prompt: string;
  caption?: string;
  aspect?: '16:9' | '4:3' | '1:1';
}

/**
 * Image models can't produce readable text or exact detail. A picture whose
 * prompt asks for screenshots, UIs, file trees, code, diagrams, grids, data
 * or lettering would come out as convincing-looking nonsense (garbled file
 * names, fake menus), so such image figures are dropped. The prompt tells the
 * author to use code blocks, Mermaid, tables or charts for these instead.
 */
const TEXT_DEPENDENT_IMAGE_RE = new RegExp(
  [
    'screen ?shots?', 'screen captures?', 'user interfaces?', '\\bui\\b', '\\bgui\\b', 'dialog(ue)? box',
    'file (browser|explorer|manager|tree|listing|structure)', 'folder (tree|structure|view)',
    'director(y|ies) (tree|layout|structure|listing)', 'project (layout|structure|tree)',
    'terminal', 'command[- ]?(line|prompt)', 'console (output|window)', '\\bshell\\b', '\\bide\\b',
    'source code', 'code (snippet|listing|editor|sample|block)', 'text editor', 'spreadsheet',
    'diagram', 'flow ?chart', 'infographic', 'schematic', 'chart', '\\bgraph\\b', 'table of',
    'sudoku (grid|board|puzzle)', 'grid (of|with) (numbers|digits|cells)', 'pencil marks',
    'labell?ed', 'with labels', 'lettering', 'typography', 'with (the )?(text|words|title|caption|numbers)',
    'written (text|words)', 'equation', 'formula',
  ].join('|'),
  'i',
);

export function isTextDependentImagePrompt(prompt: string): boolean {
  return TEXT_DEPENDENT_IMAGE_RE.test(prompt);
}

const FENCE_RE = /^```[ \t]*(chart|mermaid|image)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

function normaliseChart(raw: unknown): ChartSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const spec = raw as Record<string, unknown>;
  const type = String(spec.type || '').toLowerCase();
  if (!['bar', 'line', 'area', 'scatter', 'pie'].includes(type)) return null;

  const seriesRaw = Array.isArray(spec.series) ? spec.series : [];
  const series = seriesRaw
    .map((s) => {
      const entry = (s ?? {}) as Record<string, unknown>;
      const data = Array.isArray(entry.data) ? entry.data : [];
      const clean =
        type === 'scatter'
          ? data
              .filter((p): p is [unknown, unknown] => Array.isArray(p) && p.length >= 2)
              .map((p) => [Number(p[0]), Number(p[1])] as [number, number])
              .filter((p) => p.every(Number.isFinite))
          : data.map((v) => Number(v)).filter(Number.isFinite);
      return { name: entry.name ? String(entry.name) : undefined, data: clean };
    })
    .filter((s) => s.data.length > 0);

  if (series.length === 0) return null;

  const categories = Array.isArray(spec.categories) ? spec.categories.map(String) : undefined;
  if (type !== 'scatter' && (!categories || categories.length === 0)) return null;

  return {
    type: type as ChartSpec['type'],
    title: spec.title ? String(spec.title) : undefined,
    xLabel: spec.xLabel ? String(spec.xLabel) : undefined,
    yLabel: spec.yLabel ? String(spec.yLabel) : undefined,
    categories,
    series,
    caption: spec.caption ? String(spec.caption) : undefined,
    source: spec.source ? String(spec.source) : undefined,
  };
}

/**
 * Validate and normalise figure blocks in freshly written section Markdown.
 * Returns the cleaned Markdown and figure counts for logging.
 */
export function sanitiseSectionFigures(
  markdown: string,
  sectionId: string,
  options: { imagesEnabled: boolean },
): { markdown: string; charts: number; diagrams: number; images: number; dropped: number } {
  let charts = 0;
  let diagrams = 0;
  let images = 0;
  let dropped = 0;
  let imageIndex = 0;

  const cleaned = markdown.replace(FENCE_RE, (_block, kind: string, body: string) => {
    if (kind === 'mermaid') {
      if (!body.trim()) {
        dropped++;
        return '';
      }
      diagrams++;
      return '```mermaid\n' + body.trim() + '\n```';
    }

    const parsed = parseJsonResponse<unknown>(body);

    if (kind === 'chart') {
      const chart = normaliseChart(parsed);
      if (!chart) {
        dropped++;
        return '';
      }
      charts++;
      return '```chart\n' + JSON.stringify(chart) + '\n```';
    }

    // image
    const spec = (parsed ?? {}) as Partial<ImageSpec>;
    if (
      !options.imagesEnabled ||
      !spec.prompt ||
      typeof spec.prompt !== 'string' ||
      isTextDependentImagePrompt(spec.prompt)
    ) {
      dropped++;
      return '';
    }
    imageIndex++;
    images++;
    const image: ImageSpec = {
      id: `img-${sectionId}-${imageIndex}`,
      prompt: spec.prompt.trim(),
      caption: spec.caption ? String(spec.caption) : undefined,
      aspect: spec.aspect === '4:3' || spec.aspect === '1:1' ? spec.aspect : '16:9',
    };
    return '```image\n' + JSON.stringify(image) + '\n```';
  });

  return { markdown: cleaned, charts, diagrams, images, dropped };
}

/** All image figures declared in a section's (already sanitised) Markdown. */
export function extractImageSpecs(markdown: string): ImageSpec[] {
  const specs: ImageSpec[] = [];
  for (const match of markdown.matchAll(FENCE_RE)) {
    if (match[1] !== 'image') continue;
    try {
      const spec = JSON.parse(match[2]) as ImageSpec;
      if (spec.id && spec.prompt) specs.push(spec);
    } catch {
      /* ignore malformed */
    }
  }
  return specs;
}

const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4b5563'];

/** Render a chart spec to a standalone SVG string (ECharts SSR). */
export async function renderChartSvg(spec: ChartSpec, width = 720, height = 380): Promise<string> {
  const echarts = await import('echarts');
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });

  const baseText = { fontFamily: 'Segoe UI, Arial, sans-serif', color: '#1f2937' };
  const showLegend = spec.series.length > 1 || spec.type === 'pie';

  const option: Record<string, unknown> = {
    animation: false,
    color: PALETTE,
    textStyle: baseText,
    title: spec.title
      ? { text: spec.title, left: 'center', textStyle: { fontSize: 14, fontWeight: 600 } }
      : undefined,
    legend: showLegend ? { bottom: 0, textStyle: { fontSize: 11 } } : undefined,
    grid: { left: 64, right: 24, top: spec.title ? 48 : 24, bottom: showLegend ? 64 : 44, containLabel: true },
  };

  if (spec.type === 'pie') {
    const series = spec.series[0];
    option.series = [
      {
        type: 'pie',
        radius: ['0%', '62%'],
        center: ['50%', '52%'],
        label: { formatter: '{b}: {d}%', fontSize: 11 },
        data: (spec.categories || []).map((name, i) => ({ name, value: series.data[i] ?? 0 })),
      },
    ];
  } else {
    const isScatter = spec.type === 'scatter';
    option.xAxis = {
      type: isScatter ? 'value' : 'category',
      data: isScatter ? undefined : spec.categories,
      name: spec.xLabel,
      nameLocation: 'middle',
      nameGap: 30,
      axisLabel: { fontSize: 11, hideOverlap: true },
    };
    option.yAxis = {
      type: 'value',
      name: spec.yLabel,
      nameLocation: 'middle',
      nameGap: 48,
      axisLabel: { fontSize: 11 },
      splitLine: { lineStyle: { color: '#e5e7eb' } },
    };
    option.series = spec.series.map((s) => ({
      name: s.name,
      type: spec.type === 'area' ? 'line' : spec.type,
      data: s.data,
      smooth: spec.type === 'line' || spec.type === 'area' ? 0.2 : undefined,
      areaStyle: spec.type === 'area' ? { opacity: 0.25 } : undefined,
      symbolSize: isScatter ? 7 : 5,
      barMaxWidth: 36,
    }));
  }

  chart.setOption(option);
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg;
}
