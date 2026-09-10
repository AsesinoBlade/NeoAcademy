export function logGenerationProgress(message: string): void {
  fetch('/api/generation-progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }).catch(() => {
    // Progress logging must never interrupt generation.
  });
}
