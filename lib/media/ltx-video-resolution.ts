export interface LtxVideoResolutionPreset {
  width: number;
  height: number;
  megapixels: number;
}

export const LTX_VIDEO_RESOLUTION_PRESETS: readonly LtxVideoResolutionPreset[] = [
  { width: 576, height: 320, megapixels: 0.2 },
  { width: 704, height: 384, megapixels: 0.3 },
  { width: 832, height: 448, megapixels: 0.4 },
  { width: 960, height: 512, megapixels: 0.5 },
  { width: 1024, height: 576, megapixels: 0.6 },
  { width: 1152, height: 640, megapixels: 0.7 },
  { width: 1216, height: 640, megapixels: 0.8 },
  { width: 1280, height: 704, megapixels: 0.9 },
  { width: 1344, height: 768, megapixels: 1.0 },
  { width: 1472, height: 832, megapixels: 1.2 },
  { width: 1664, height: 896, megapixels: 1.5 },
  { width: 1792, height: 1024, megapixels: 1.8 },
  { width: 1920, height: 1088, megapixels: 2.0 },
];

export const DEFAULT_LTX_VIDEO_RESOLUTION = {
  width: 1280,
  height: 704,
} as const;

export function isLtxVideoResolutionPreset(
  width: number,
  height: number,
): boolean {
  return LTX_VIDEO_RESOLUTION_PRESETS.some(
    (preset) => preset.width === width && preset.height === height,
  );
}

export function getLtxVideoResolutionPreset(
  key: string,
): LtxVideoResolutionPreset | undefined {
  return LTX_VIDEO_RESOLUTION_PRESETS.find(
    (preset) => `${preset.width}x${preset.height}` === key,
  );
}