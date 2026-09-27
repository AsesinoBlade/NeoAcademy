/**
 * Constants for PDF content generation
 * Shared between client and server code
 */

// PDF content truncation limit (characters)
const configuredMaxSourceTextChars =
  Number.parseInt(
    process.env.NEXT_PUBLIC_MAX_SOURCE_TEXT_CHARS ??
      '',
    10,
  );

export const MAX_SOURCE_TEXT_CHARS =
  Number.isFinite(configuredMaxSourceTextChars) &&
  configuredMaxSourceTextChars > 0
    ? configuredMaxSourceTextChars
    : 50000;

// Maximum number of images to send as vision content parts
export const MAX_VISION_IMAGES = 20;
