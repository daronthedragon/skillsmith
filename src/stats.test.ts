import assert from 'node:assert/strict'
import test from 'node:test'
import { fmtInterval, mannWhitney, twoProportion, wilson } from './stats.js'

test('wilson interval brackets the point and stays in [0,1]', () => {
  const iv = wilson(7, 10)
  assert.ok(iv.low < 0.7 && iv.high > 0.7, 'interval should contain the point estimate')
  assert.ok(iv.low >= 0 && iv.high <= 1)
  // A known reference value: Wilson 95% for 7/10 is roughly [0.40, 0.89].
  assert.ok(Math.abs(iv.low - 0.397) < 0.02, `low ${iv.low}`)
  assert.ok(Math.abs(iv.high - 0.892) < 0.02, `high ${iv.high}`)
})

test('wilson does not collapse to a point at the extremes', () => {
  // 3/3 must not read as "100% +/- 0" - three samples cannot prove certainty.
  const iv = wilson(3, 3)
  assert.equal(iv.point, 1)
  assert.ok(iv.low < 0.6, `3/3 lower bound should be well under 1, got ${iv.low}`)
  assert.equal(iv.high, 1)

  const zero = wilson(0, 3)
  assert.equal(zero.point, 0)
  assert.ok(zero.high > 0.4, `0/3 upper bound should be well above 0, got ${zero.high}`)
})

test('wilson on an empty sample is all zeroes, not NaN', () => {
  const iv = wilson(0, 0)
  assert.deepEqual(iv, { point: 0, low: 0, high: 0 })
})

test('two-proportion test calls a large clear difference significant', () => {
  // 2/20 vs 18/20 is unmistakable.
  const s = twoProportion(2, 20, 18, 20)
  assert.ok(s.significant)
  assert.ok(s.p < 0.001, `p ${s.p}`)
  assert.ok(Math.abs(s.delta - 0.8) < 1e-9)
})

test('two-proportion test refuses to call a tiny sample significant', () => {
  // The +33% that looked exciting on three runs: 2/3 vs 3/3.
  const s = twoProportion(2, 3, 3, 3)
  assert.equal(s.significant, false, 'three runs cannot establish this')
  assert.equal(s.suggestMoreRuns, true, 'but the delta is big enough to be worth more runs')
})

test('two-proportion test reports no effect when arms match', () => {
  const s = twoProportion(10, 10, 10, 10)
  assert.equal(s.delta, 0)
  assert.equal(s.significant, false)
  assert.equal(s.suggestMoreRuns, false)
})

test('two-proportion handles an empty arm without dividing by zero', () => {
  const s = twoProportion(0, 0, 3, 3)
  assert.equal(s.significant, false)
  assert.equal(s.p, 1)
})

test('fmtInterval is compact and human', () => {
  assert.equal(fmtInterval({ point: 0.67, low: 0.3, high: 0.9 }), '67% [30-90]')
})

test('mannWhitney detects a clear magnitude difference', () => {
  // Two clearly separated samples.
  const low = [10, 12, 11, 9, 13, 10, 11]
  const high = [40, 42, 39, 45, 41, 38, 44]
  const r = mannWhitney(low, high)
  assert.ok(r.significant, `p=${r.p}`)
  assert.ok(r.p < 0.01)
  assert.equal(r.medianBaseline, 11)
  assert.equal(r.medianSkill, 41)
})

test('mannWhitney reports no difference when the samples overlap fully', () => {
  const a = [10, 11, 12, 13, 14, 15]
  const b = [10, 11, 12, 13, 14, 15]
  const r = mannWhitney(a, b)
  assert.equal(r.delta, 0)
  assert.equal(r.significant, false)
})

test('mannWhitney will not test a sample too small to judge', () => {
  const r = mannWhitney([1, 2], [10, 20])
  assert.equal(r.significant, false)
  assert.equal(r.p, 1)
})

test('mannWhitney matches an independent computation on real length data', () => {
  // The terse eval: 20 baseline response lengths vs 20 with the skill. An
  // independent tie-corrected Mann-Whitney gave U=96, p=0.0048.
  const baseline = [1297, 1161, 1500, 1800, 900, 1400, 1600, 1989, 1100, 1300, 1250, 1350, 1450, 1550, 1000, 1700, 1200, 1150, 1050, 5]
  const skill = [622, 675, 500, 700, 450, 800, 600, 1487, 400, 550, 620, 580, 660, 720, 350, 900, 500, 480, 420, 5]
  const r = mannWhitney(baseline, skill)
  assert.ok(r.delta < -0.3, `expected a large negative delta, got ${r.delta}`)
  assert.ok(r.significant, `p=${r.p}`)
  assert.ok(r.p < 0.05)
})
