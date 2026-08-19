/**
 * Just enough statistics to say whether a delta is real, with no dependency.
 *
 * An eval that reports "67% -> 100%" from three runs is reporting an anecdote.
 * These turn a pass count into an interval and a two-arm difference into a
 * verdict, so the report can distinguish a real change from noise at the
 * sample size actually run.
 */

/** Standard-normal quantile for a two-sided interval. 95% -> 1.96. */
const Z_95 = 1.959963984540054

export interface Interval {
  point: number
  low: number
  high: number
}

/**
 * Wilson score interval for a binomial proportion. Behaves sensibly at the
 * edges where the normal approximation falls apart: 3/3 does not come back as
 * "100% +/- 0", it comes back as an interval that honestly reflects three
 * samples.
 */
export function wilson(passed: number, total: number, z = Z_95): Interval {
  if (total === 0) return { point: 0, low: 0, high: 0 }
  const p = passed / total
  const z2 = z * z
  const denom = 1 + z2 / total
  const centre = (p + z2 / (2 * total)) / denom
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))
  return {
    point: p,
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
  }
}

export interface Significance {
  delta: number
  /** Two-sided p-value for the two-proportion difference. */
  p: number
  significant: boolean
  /** How many more runs per arm would likely resolve an inconclusive result. */
  suggestMoreRuns: boolean
}

/** Normal CDF via the error function, for the two-proportion p-value. */
function normalCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26 approximation of erf.
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const erf =
    1 -
    t *
      (0.254829592 +
        t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
      Math.exp((-x * x) / 2)
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

/**
 * Two-proportion z-test on pooled variance. `alpha` defaults to 0.05.
 *
 * With tiny samples almost nothing clears significance, which is the honest
 * answer: three runs cannot establish a 33-point difference. `suggestMoreRuns`
 * flags the case where the point delta is large but the sample is too small to
 * call, so the report can say "promising, run more" rather than "proven".
 */
export function twoProportion(
  passA: number,
  totalA: number,
  passB: number,
  totalB: number,
  alpha = 0.05,
): Significance {
  const pA = totalA ? passA / totalA : 0
  const pB = totalB ? passB / totalB : 0
  const delta = pB - pA

  if (totalA === 0 || totalB === 0) {
    return { delta, p: 1, significant: false, suggestMoreRuns: false }
  }

  const pool = (passA + passB) / (totalA + totalB)
  const se = Math.sqrt(pool * (1 - pool) * (1 / totalA + 1 / totalB))
  if (se === 0) {
    // No variance to test: identical certain outcomes.
    return { delta, p: delta === 0 ? 1 : 0, significant: delta !== 0, suggestMoreRuns: false }
  }

  const z = delta / se
  const p = 2 * (1 - normalCdf(Math.abs(z)))
  const significant = p < alpha
  const suggestMoreRuns = !significant && Math.abs(delta) >= 0.2
  return { delta, p, significant, suggestMoreRuns }
}

/** Format a proportion interval as a compact "67% [30-90]". */
export function fmtInterval(iv: Interval): string {
  const pct = (n: number) => `${Math.round(n * 100)}`
  return `${pct(iv.point)}% [${pct(iv.low)}-${pct(iv.high)}]`
}
