export type ImageJobStatus =
  | 'queued'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ImageJobMode =
  | 'text-to-image'
  | 'single-image-edit'
  | 'two-image-edit';

export interface ImageJob {
  id: string;

  status: ImageJobStatus;

  mode: ImageJobMode;

  origin: 'standalone' | 'classroom';

  stageId?: string;

  elementId?: string;

  prompt: string;

  /**
   * Whether Prompt 1 should be enhanced before it is sent to Flux.
   * Defaults to false for callers that do not explicitly request it.
   */
  enhancePrompt?: boolean;

  enhancedPrompt?: string;

  secondPrompt?: string;

  /**
   * Whether Prompt 2 should be enhanced independently of Prompt 1.
   */
  enhanceSecondPrompt?: boolean;

  enhancedSecondPrompt?: string;

  negativePrompt?: string;

  width: number;

  height: number;

  sourceImage1Path?: string;

  sourceImage2Path?: string;

  outputPath?: string;

  error?: string;

  createdAt: string;

  updatedAt: string;
}