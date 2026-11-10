/** Formats a model output score without implying probability calibration. */
export function formatModelScore(score: number | null | undefined): string {
  return typeof score === 'number' && Number.isFinite(score) ? score.toFixed(2) : '—'
}

export function formatModelScoreWithCaveat(score: number | null | undefined): string {
  return `${formatModelScore(score)} (정답 확률 아님)`
}
