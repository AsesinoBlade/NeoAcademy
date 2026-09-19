import type { LongVideoJob, LongVideoJobSegment } from './long-video-job';

export function getNextLongVideoJobSegment(job: LongVideoJob): LongVideoJobSegment | null {
  const interruptedSegment = job.segments.find((segment) => segment.status === 'generating');

  if (interruptedSegment) {
    return interruptedSegment;
  }

  const failedSegment = job.segments.find((segment) => segment.status === 'failed');

  if (failedSegment) {
    return failedSegment;
  }

  const pendingSegment = job.segments.find((segment) => segment.status === 'pending');

  return pendingSegment || null;
}

export function prepareLongVideoJobForResume(
  job: LongVideoJob,
): LongVideoJob {
  return {
    ...job,
    status: 'generating',
    segments: job.segments.map((segment) =>
      segment.status === 'generating'
        ? {
            ...segment,
            status: 'pending',
            error: undefined,
          }
        : segment,
    ),
    currentSegmentIndex: undefined,
    error: undefined,
  };
}