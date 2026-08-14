const Z = 1.96 // 95%

/** Wilson score interval — honest at small n, unlike the normal approximation. */
export function wilson(wins: number, n: number): { p: number; half: number } {
  if (!n) return { p: 0, half: 0 }
  const p = wins / n
  const d = 1 + (Z * Z) / n
  const centre = (p + (Z * Z) / (2 * n)) / d
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / d
  return { p: centre, half }
}
