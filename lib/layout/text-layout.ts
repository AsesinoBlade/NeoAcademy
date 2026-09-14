export interface TextHeightEstimateOptions {
  html: string;
  width: number;
  defaultFontSize?: number;
  lineHeight?: number;
  padding?: number;
}

function stripTags(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function getLargestFontSize(html: string, fallback: number): number {
  const matches = [...html.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)];

  if (matches.length === 0) return fallback;

  return Math.max(fallback, ...matches.map((match) => Number.parseFloat(match[1])));
}

export function estimateTextHeight({
  html,
  width,
  defaultFontSize = 18,
  lineHeight = 1.5,
  padding = 20,
}: TextHeightEstimateOptions): number {
  const usableWidth = Math.max(1, width - padding);
  const fontSize = getLargestFontSize(html, defaultFontSize);

  // Conservative average glyph width. English body text is normally
  // around 0.5-0.6em; using 0.6 gives us some safety against wrapping.
  const averageCharacterWidth = fontSize * 0.6;
  const charactersPerLine = Math.max(1, Math.floor(usableWidth / averageCharacterWidth));

  const text = stripTags(html);

  const paragraphs = text
    .split('\n')
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return Math.ceil(fontSize * lineHeight + padding);
  }

  let totalLines = 0;

  for (const paragraph of paragraphs) {
    totalLines += Math.max(1, Math.ceil(paragraph.length / charactersPerLine));
  }

  const lineHeightPx = fontSize * lineHeight;

  return Math.ceil(totalLines * lineHeightPx + padding);
}

export interface FitTextToHeightOptions {
  html: string;
  width: number;
  maxHeight: number;
  lineHeight?: number;
  defaultFontSize?: number;
  minimumFontSize?: number;
  padding?: number;
}

export interface FitTextToHeightResult {
  html: string;
  estimatedHeight: number;
  changed: boolean;
  scale: number;
}

function scaleHtmlFontSizes(html: string, scale: number, minimumFontSize: number): string {
  return html.replace(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi, (_match, sizeText: string) => {
    const originalSize = Number.parseFloat(sizeText);

    const scaledSize = Math.max(minimumFontSize, Math.round(originalSize * scale));

    return `font-size: ${scaledSize}px`;
  });
}

export function fitTextToHeight({
  html,
  width,
  maxHeight,
  lineHeight = 1.5,
  defaultFontSize = 18,
  minimumFontSize = 14,
  padding = 20,
}: FitTextToHeightOptions): FitTextToHeightResult {
  const initialHeight = estimateTextHeight({
    html,
    width,
    defaultFontSize,
    lineHeight,
    padding,
  });

  if (initialHeight <= maxHeight) {
    return {
      html,
      estimatedHeight: initialHeight,
      changed: false,
      scale: 1,
    };
  }

  // Start with the ratio suggested by the amount of overflow.
  // Re-estimate after each adjustment because wrapping is nonlinear.
  let scale = Math.max(minimumFontSize / defaultFontSize, maxHeight / initialHeight);

  for (let attempt = 0; attempt < 12; attempt++) {
    const scaledHtml = scaleHtmlFontSizes(html, scale, minimumFontSize);

    const estimatedHeight = estimateTextHeight({
      html: scaledHtml,
      width,
      defaultFontSize: Math.max(minimumFontSize, defaultFontSize * scale),
      lineHeight,
      padding,
    });

    if (estimatedHeight <= maxHeight) {
      return {
        html: scaledHtml,
        estimatedHeight,
        changed: true,
        scale,
      };
    }

    if (scale <= minimumFontSize / defaultFontSize) {
      break;
    }

    scale = Math.max(minimumFontSize / defaultFontSize, scale - 0.05);
  }

  const finalHtml = scaleHtmlFontSizes(html, scale, minimumFontSize);

  return {
    html: finalHtml,
    estimatedHeight: estimateTextHeight({
      html: finalHtml,
      width,
      defaultFontSize: Math.max(minimumFontSize, defaultFontSize * scale),
      lineHeight,
      padding,
    }),
    changed: finalHtml !== html,
    scale,
  };
}
