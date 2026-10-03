function getPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const PRESENTATION_TITLE_FONT_SIZE = getPositiveNumber(
  process.env.NEXT_PUBLIC_PRESENTATION_TITLE_FONT_SIZE,
  24,
);

export const PRESENTATION_HEADING_FONT_SIZE = getPositiveNumber(
  process.env.NEXT_PUBLIC_PRESENTATION_HEADING_FONT_SIZE,
  18,
);

export const PRESENTATION_TEXT_FONT_SIZE = getPositiveNumber(
  process.env.NEXT_PUBLIC_PRESENTATION_TEXT_FONT_SIZE,
  14,
);