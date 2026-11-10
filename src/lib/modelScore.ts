/** Formats a model output score without implying probability calibration. */
export function formatModelScore(score: number | null | undefined): string {
  return typeof score === 'number' && Number.isFinite(score) ? score.toFixed(2) : '—'
}
