import type { LongVideoPlan } from './long-video-plan';

export type LongVideoJobStatus =
  | 'queued'
  | 'planning'
  | 'generating'
  | 'assembling'
  | 'completed'
  | 'failed';

export type LongVideoSegmentStatus = 'pending' | 'generating' | 'completed' | 'failed';

export interface LongVideoJobSegment {
  index: number;

  status: LongVideoSegmentStatus;

  attemptCount?: number;

  outputPath?: string;

  error?: string;
}

export interface LongVideoJob {
  id: string;

  status: LongVideoJobStatus;

  prompt: string;

  targetDurationSeconds: number;

  startingImagePath?: string;

  plan?: LongVideoPlan;

  segmentCount: number;

  completedSegments: number;

  currentSegmentIndex?: number;

  segments: LongVideoJobSegment[];

  outputPath?: string;

  error?: string;

  createdAt: string;

  updatedAt: string;
}
