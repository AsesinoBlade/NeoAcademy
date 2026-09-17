function getPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const WHITEBOARD_LARGE_HEADING_FONT_SIZE = getPositiveNumber(
  process.env.NEXT_PUBLIC_WHITEBOARD_LARGE_HEADING_FONT_SIZE,
  16,
);

export const WHITEBOARD_SMALL_HEADING_FONT_SIZE = getPositiveNumber(
  process.env.NEXT_PUBLIC_WHITEBOARD_SMALL_HEADING_FONT_SIZE,
  14,
);

export const WHITEBOARD_TEXT_FONT_SIZE = getPositiveNumber(
  process.env.NEXT_PUBLIC_WHITEBOARD_TEXT_FONT_SIZE,
  12,
);
