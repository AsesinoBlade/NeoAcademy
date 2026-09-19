export type VideoSegmentTransition = 'continue' | 'cut';

export interface LongVideoSegment {
  index: number;
  durationSeconds: number;
  prompt: string;
  transition: VideoSegmentTransition;
}

export interface LongVideoPlan {
  targetDurationSeconds: number;
  segmentDurationSeconds: number;
  segments: LongVideoSegment[];
}
