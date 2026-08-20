import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mannWhitney, twoProportion, wilson, type Comparison, type Interval, type Significance } from './stats.js'

/**
 * An eval is a set of prompts plus checks that can be scored from the
 * transcript text alone. No model-as-judge: a judge is another prompt whose
 * behaviour you cannot verify, and the whole point here is verification.
 */
export interface Check {
  /**
   * Optional self-test for this check's pattern: strings it must match, and
   * strings it must not. Validated before a single API call is spent.
   *
   * A regex is written once and then trusted forever, and a mangled one does
   * not announce itself - it silently reports 0%, which reads as "the skill
   * broke" rather than "the check is broken". That has happened three times in
   * this project, twice from a shell eating a backslash (`\b` arriving as a
   * backspace character) and once from `$400`, where `$` is end-of-string and
   * the pattern could never match anything.
   */
  examples?: { match?: string[]; reject?: string[] }
  /** Short id shown in the report. */
  id: string
  /** What this check is looking for, in plain words. */
  describe: string
  /**
   * Regex tested against the full transcript. `expect: true` means the skill
   * should make this appear; `expect: false` means it should make it go away.
   */
  pattern: string
  flags?: string
  expect: boolean
  /** Optional: pass only if the match count satisfies this. */
  max?: number
  min?: number
  /**
   * Implication guard. When set, the check only bites if `given` matches the
   * transcript, so it reads as "WHEN the agent does X, it must also do Y" -
   * e.g. when it claims success, a real run must be present. A transcript that
   * never triggers the guard passes vacuously: not over-claiming is not a
   * failure. This is what lets checks match a behaviour rather than a keyword.
   */
  given?: string
  givenFlags?: string
}

export interface EvalCase {
  id: string
  prompt: string
  checks: Check[]
}

export interface EvalSpec {
  /** Path to the SKILL.md under test. */
  skill: string
  /**
   * Command that runs one prompt and prints the transcript to stdout.
   * `{prompt}` is replaced with the prompt (shell-quoted); `{skill}` with the
   * path to a temporary skills directory containing the skill, or an empty
   * directory for the baseline. Example for the claude CLI:
   *   claude -p {prompt} --output-format text --settings {settings}
   */
  runner: string
  cases: EvalCase[]
  /** Repeat each case this many times to smooth variance. Default 1. */
  repeat?: number
  timeoutMs?: number
  /** Runs in flight at once. Default 4. */
  concurrency?: number
  /**
   * Evaluate a Claude Code output style instead of a skill. When set, the skill
   * arm stages the output-style file into `.claude/output-styles/` and turns it
   * on via `.claude/settings.json` (`outputStyle`), rather than staging a skill.
   * The baseline arm gets neither. `file` is resolved relative to the eval spec.
   */
  outputStyle?: { name: string; file: string }
}

export interface CaseResult {
  id: string
  arm: 'baseline' | 'skill'
  run: number
  transcript: string
  checks: Array<{ id: string; passed: boolean; matches: number; applicable?: boolean }>
  exitCode: number
  /** Tokens the run consumed, or null when the transcript carries no usage. */
  tokens: number | null
  /** Wall-clock for this run. Concurrency inflates it, but both arms are
   * interleaved through the same pool, so the arms stay comparable. Optional so
   * a report captured before timing existed still parses. */
  durationMs?: number
}

export interface EvalReport {
  spec: EvalSpec
  results: CaseResult[]
  /** Per check: pass rate without the skill vs with it. `null` for an arm means
   * the check never applied there (a guard that did not trigger), which is not
   * the same as 0% - and `delta` is then null too, not a misleading -100%. */
  summary: Array<{
    caseId: string
    checkId: string
    baseline: number | null
    skill: number | null
    delta: number | null
    /** How many runs per arm actually triggered the check's guard. */
    baselineApplicable: number
    skillApplicable: number
  }>
  /** Mean pass rate across all checks, both arms. */
  baselineScore: number
  skillScore: number
  /**
   * Significance of the overall difference, pooled across every check outcome
   * so the sample is as large as the eval affords. This is what separates a
   * real change from three lucky runs.
   */
  significance: Significance & {
    baseline: Interval
    skill: Interval
    baselinePassed: number
    skillPassed: number
    total: number
  }
  /** Median tokens per run for each arm, and the skill's added cost. */
  cost: {
    baselineMedian: number | null
    skillMedian: number | null
    /** skill − baseline, i.e. what the skill adds per turn. Null if unknown. */
    delta: number | null
  }
  /**
   * Magnitude effects the pass/fail checks cannot see: does the skill make
   * responses shorter, cheaper, use fewer tool calls? Each is a Mann-Whitney
   * comparison of a continuous per-run metric between the arms. This is what
   * catches a skill like terse, whose whole value is "less", when every binary
   * check reads the same in both arms.
   */
  metrics: MetricResult[]
}

export interface MetricResult {
  name: string
  unit: string
  comparison: Comparison
}

/**
 * Quote one argument for whatever shell spawn() will use. Node picks cmd.exe on
 * Windows, where a single quote is an ordinary character, so POSIX quoting there
 * leaves cmd waiting on an unterminated token and the runner hangs.
 *
 * Inside cmd.exe double quotes the only character that still needs escaping is
 * the double quote itself; `^` and `!` are literal there, so escaping them (as
 * an earlier version did) baked stray carets into the prompt the model saw.
 * Two cases cannot be represented on a cmd.exe command line at all — an embedded
 * newline, and `%VAR%` where VAR is a defined environment variable — so those
 * are rejected loudly rather than silently mangled.
 */
export function shellQuote(text: string): string {
  if (process.platform === 'win32') {
    if (text.includes('\n') || text.includes('\r')) {
      throw new Error('A runner prompt cannot contain a newline on Windows (cmd.exe limitation). Keep prompts to one line.')
    }
    return `"${text.replace(/"/g, '""')}"`
  }
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * Kill a spawned shell AND its descendants. `shell: true` makes cmd.exe (or sh)
 * the direct child, so killing the child alone orphans the real runner - a
 * `claude -p` call that keeps running, and costing money, after a timeout. On
 * Windows taskkill /T walks the tree; on POSIX the shell usually forwards the
 * signal, and killing the pid is the portable best effort.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } catch {
      child.kill('SIGKILL')
    }
  } else {
    child.kill('SIGKILL')
  }
}

export function runCommand(command: string, timeoutMs: number): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    // stdin is ignored, i.e. closed: the child sees EOF immediately, so a CLI
    // that would otherwise wait on stdin proceeds at once. This replaces a
    // `< /dev/null` redirect in the command, which breaks under cmd.exe where
    // the path is NUL, not /dev/null.
    const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      killTree(child)
      resolve({ stdout: stdout + '\n[skillsmith: runner timed out]', code: 124 })
    }, timeoutMs)
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
    child.stderr?.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ stdout, code: code ?? 0 })
    })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ stdout: `[skillsmith: ${err.message}]`, code: 1 })
    })
  })
}

export function scoreTranscript(transcript: string, checks: Check[]): CaseResult['checks'] {
  return checks.map((check) => {
    // Implication guard: if the trigger is absent, the requirement does not
    // apply and the check passes vacuously.
    if (check.given !== undefined) {
      const guard = new RegExp(check.given, check.givenFlags ?? 'gi')
      if (!guard.test(transcript)) return { id: check.id, passed: true, matches: 0, applicable: false }
    }

    const re = new RegExp(check.pattern, check.flags ?? 'gi')
    const matches = (transcript.match(re) ?? []).length
    let passed: boolean
    if (check.expect) {
      passed = matches > 0
      if (check.min !== undefined) passed = passed && matches >= check.min
      if (check.max !== undefined) passed = passed && matches <= check.max
    } else {
      passed = check.max !== undefined ? matches <= check.max : matches === 0
    }
    return { id: check.id, passed, matches, applicable: true }
  })
}

/**
 * Materialise a throwaway project directory for ONE run. Agents that load
 * project skills from `<cwd>/.claude/skills/` pick the skill up by running with
 * this directory as cwd; the baseline gets the same layout with the skills
 * folder empty, so the only difference between arms is the skill.
 *
 * One directory per run, not per arm: a run whose prompt writes a file would
 * otherwise leave it for the next run in the same arm to trip over, and it
 * makes runs safe to execute concurrently.
 */
async function stageRun(spec: EvalSpec, arm: 'baseline' | 'skill'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `skillsmith-${arm}-`))
  try {
    const { mkdir } = await import('node:fs/promises')
    const claudeDir = join(dir, '.claude')

    if (spec.outputStyle) {
      // Output-style arm: stage the style file and turn it on via settings.
      // The baseline arm gets a plain project with no style.
      if (arm === 'skill') {
        const stylesDir = join(claudeDir, 'output-styles')
        await mkdir(stylesDir, { recursive: true })
        const raw = await readFile(spec.outputStyle.file, 'utf8')
        await writeFile(join(stylesDir, `${spec.outputStyle.name}.md`), raw, 'utf8')
        await writeFile(
          join(claudeDir, 'settings.json'),
          JSON.stringify({ outputStyle: spec.outputStyle.name }, null, 2),
          'utf8',
        )
      } else {
        await mkdir(claudeDir, { recursive: true })
      }
      return dir
    }

    const skillsDir = join(claudeDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    if (arm === 'skill') {
      const raw = await readFile(spec.skill, 'utf8')
      const name = /^name:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? 'skill-under-test'
      await mkdir(join(skillsDir, name), { recursive: true })
      await writeFile(join(skillsDir, name, 'SKILL.md'), raw, 'utf8')
    }
    return dir
  } catch (err) {
    // Never leak the temp dir if staging fails partway through.
    await rm(dir, { recursive: true, force: true })
    throw err
  }
}

/** Fail fast on an unusable spec, before spawning anything, so a bad regex or a
 * missing skill cannot abort mid-run and orphan in-flight jobs. */
function validateSpec(spec: EvalSpec): void {
  if (!Array.isArray(spec.cases) || spec.cases.length === 0) {
    throw new Error('eval.json has no cases to run.')
  }
  for (const testCase of spec.cases) {
    for (const check of testCase.checks) {
      const compile = (pattern: string, label: string) => {
        try {
          new RegExp(pattern, check.flags ?? 'gi')
        } catch (err) {
          throw new Error(
            `Check "${testCase.id}/${check.id}" has an invalid ${label} regex: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      compile(check.pattern, 'pattern')
      if (check.given !== undefined) compile(check.given, 'given')

      // A check that carries examples is tested against them here, before any
      // call is made, so a broken pattern fails in a second rather than after
      // an hour of paid runs that all report 0%.
      if (check.examples) {
        const re = () => new RegExp(check.pattern, check.flags ?? 'gi')
        const label = `Check "${testCase.id}/${check.id}"`
        for (const sample of check.examples.match ?? []) {
          if (!re().test(sample)) {
            throw new Error(
              `${label} does not match its own example: ${JSON.stringify(sample)}
` +
                `  pattern: ${JSON.stringify(check.pattern)}
` +
                '  A pattern that fails its own example is mangled or wrong; fix it before spending a run.',
            )
          }
        }
        for (const sample of check.examples.reject ?? []) {
          if (re().test(sample)) {
            throw new Error(
              `${label} matches a string it should reject: ${JSON.stringify(sample)}
` +
                `  pattern: ${JSON.stringify(check.pattern)}
` +
                '  A check this loose will pass on replies that are actually wrong.',
            )
          }
        }
      }
    }
  }
}

const TOKEN_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const

function sumUsage(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null
  let total = 0
  let found = false
  for (const key of TOKEN_FIELDS) {
    const v = (usage as Record<string, unknown>)[key]
    if (typeof v === 'number') {
      total += v
      found = true
    }
  }
  return found ? total : null
}

/**
 * Total tokens the run consumed, from Claude Code's stream-json transcript.
 *
 * Parsed as JSONL, not by regex over the raw text: a `usage` object nests other
 * objects (a regex stopping at the first `}` truncates it), and the same call's
 * usage is echoed once per assistant event and again in the `result` event
 * (summing every occurrence triple-counts). The `result` event carries the
 * authoritative cumulative total — the same figure that drives the CLI's
 * reported cost — so use it when present, and fall back to the assistant
 * messages only when there is no result event. Returns null when no usage is
 * present, so the report can tell "zero" from "unknown".
 */
export function parseTokens(transcript: string): number | null {
  const objects: Array<Record<string, unknown>> = []
  for (const line of transcript.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    try {
      objects.push(JSON.parse(trimmed) as Record<string, unknown>)
    } catch {
      // Not a JSON line (e.g. a plain-text runner); ignore it.
    }
  }

  // Authoritative: the final result event's cumulative usage.
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i] as Record<string, unknown>
    if (o.type === 'result') {
      const s = sumUsage(o.usage ?? (o.message as Record<string, unknown> | undefined)?.usage)
      if (s !== null) return s
    }
  }

  // Fallback: sum the per-message usages when no result event carried one.
  let total = 0
  let found = false
  for (const o of objects) {
    const s = sumUsage((o.message as Record<string, unknown> | undefined)?.usage ?? o.usage)
    if (s !== null) {
      total += s
      found = true
    }
  }
  return found ? total : null
}

/** Output tokens only, from the result event — the part a brevity skill moves. */
export function parseOutputTokens(transcript: string): number | null {
  for (const line of transcript.split('\n').reverse()) {
    const t = line.trim()
    if (t[0] !== '{') continue
    try {
      const o = JSON.parse(t) as Record<string, unknown>
      if (o.type !== 'result') continue
      const usage = (o.usage ?? (o.message as Record<string, unknown> | undefined)?.usage) as
        | Record<string, unknown>
        | undefined
      const out = usage?.output_tokens
      if (typeof out === 'number') return out
    } catch {
      // ignore non-JSON lines
    }
  }
  return null
}

/**
 * Continuous per-run metrics, compared between arms with Mann-Whitney. Derived
 * from the stored transcripts, so this runs at render time too and works on a
 * report captured before metrics existed. A metric is only reported when both
 * arms have enough non-null samples to test.
 */
export function computeMetrics(results: CaseResult[]): MetricResult[] {
  const byArm = (arm: 'baseline' | 'skill', pick: (r: CaseResult) => number | null): number[] =>
    results
      .filter((r) => r.arm === arm)
      .map(pick)
      .filter((v): v is number => v !== null)

  const specs: Array<{ name: string; unit: string; pick: (r: CaseResult) => number | null }> = [
    { name: 'response length', unit: 'chars', pick: (r) => r.transcript.trim().length || null },
    { name: 'output tokens', unit: 'tokens', pick: (r) => parseOutputTokens(r.transcript) },
    { name: 'wall clock', unit: 'ms', pick: (r) => r.durationMs ?? null },
  ]

  const out: MetricResult[] = []
  for (const spec of specs) {
    const b = byArm('baseline', spec.pick)
    const s = byArm('skill', spec.pick)
    if (b.length < 3 || s.length < 3) continue
    out.push({ name: spec.name, unit: spec.unit, comparison: mannWhitney(b, s) })
  }
  return out
}

/**
 * Delete a run's staging directory, and never let that deletion end the eval.
 *
 * On Windows the runner's own process can still hold a handle to the temp tree
 * for a moment after it exits (and a virus scanner can hold one for longer), so
 * `rm` throws EBUSY/EPERM. This ran in a `finally`, so the throw propagated out
 * of the worker and aborted the whole run - discarding every result already
 * paid for. A leftover temp directory is worth far less than the run, so retry
 * briefly and then give up quietly.
 */
async function cleanupStaging(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)))
    }
  }
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    // The OS still holds it. It is in the temp directory; leave it there.
  }
}

/**
 * A regression gate for CI. `--min-reduction 50` means "the metric must still be
 * at least 50% smaller with the skill, and significantly so". Without a gate a
 * measured claim in a README rots silently: the model changes, the effect
 * shrinks, and the number in the docs keeps asserting what used to be true.
 * With one, the build fails the moment the claim stops holding.
 */
export function gateReport(
  report: EvalReport,
  opts: { minReduction?: number; metric?: string; minPass?: number },
): { ok: boolean; line: string } {
  const lines: string[] = []
  let ok = true

  // Before any threshold: did the runs actually run? A gate that passes on
  // transcripts which are really error messages is worse than no gate, because
  // it launders a broken harness into a green build. One in ten is the line -
  // an occasional flake is tolerable, a systematic failure is not.
  const failed = report.results.filter((r) => r.exitCode !== 0).length
  if (failed > 0) {
    const pct = (failed / report.results.length) * 100
    const tolerable = pct <= 10
    lines.push(
      `  gate: ${failed}/${report.results.length} runs did not exit 0 (${pct.toFixed(0)}%)  ${tolerable ? 'tolerated' : 'FAIL - results are contaminated'}`,
    )
    ok &&= tolerable
  }

  if (opts.minReduction !== undefined) {
    const metric = opts.metric ?? 'response length'
    const metrics = computeMetrics(report.results)
    const m = metrics.find((x) => x.name === metric)
    if (!m) {
      const names = metrics.map((x) => x.name).join(', ') || 'none'
      lines.push(`  gate: no metric named "${metric}" in this report (have: ${names})`)
      ok = false
    } else {
      const gotPct = -m.comparison.delta * 100
      const pass = m.comparison.significant && gotPct >= opts.minReduction
      const sig = m.comparison.significant
        ? `p=${m.comparison.p.toFixed(3)}`
        : `NOT significant (p=${m.comparison.p.toFixed(2)})`
      lines.push(
        `  gate: ${metric} -${gotPct.toFixed(0)}% vs -${opts.minReduction}% required, ${sig}  ${pass ? 'PASS' : 'FAIL'}`,
      )
      ok &&= pass
    }
  }

  // A floor on the skill arm's pass rate. This is the gate a *safety* benchmark
  // needs: there the skill is not supposed to win anything, it is supposed not
  // to break what already worked, so "did it beat the baseline" is the wrong
  // question and a floor is the right one.
  if (opts.minPass !== undefined) {
    const got = report.skillScore * 100
    const pass = got >= opts.minPass
    lines.push(
      `  gate: skill pass rate ${got.toFixed(0)}% vs ${opts.minPass}% required  ${pass ? 'PASS' : 'FAIL'}`,
    )
    ok &&= pass
  }

  if (lines.length === 0) return { ok: true, line: '' }
  return { ok, line: lines.join('\n') }
}

/** Run up to `limit` promises at a time, preserving result order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T)
    }
  })
  await Promise.all(workers)
  return results
}

export async function runEval(
  spec: EvalSpec,
  onProgress?: (line: string) => void,
): Promise<EvalReport> {
  validateSpec(spec)
  const repeat = spec.repeat ?? 1
  const timeout = spec.timeoutMs ?? 180_000
  const concurrency = spec.concurrency ?? 4

  // Flatten every (arm, case, run) into one job list, then run the list
  // through a bounded pool. Cheaper wall-clock, and each job is independent.
  const jobs = (['baseline', 'skill'] as const).flatMap((arm) =>
    spec.cases.flatMap((testCase) =>
      Array.from({ length: repeat }, (_, i) => ({ arm, testCase, run: i + 1 })),
    ),
  )

  let done = 0
  const results = await pool(jobs, concurrency, async ({ arm, testCase, run }) => {
    const cwd = await stageRun(spec, arm)
    try {
      const command = spec.runner
        .replace('{prompt}', shellQuote(testCase.prompt))
        .replace('{skill}', shellQuote(cwd))
      const startedAt = Date.now()
      const { stdout, code } = await runCommand(command, timeout)
      const durationMs = Date.now() - startedAt
      onProgress?.(`[${++done}/${jobs.length}] ${arm.padEnd(8)} ${testCase.id} run ${run}`)
      return {
        id: testCase.id,
        arm,
        run,
        transcript: stdout,
        checks: scoreTranscript(stdout, testCase.checks),
        exitCode: code,
        tokens: parseTokens(stdout),
        durationMs,
      } satisfies CaseResult
    } finally {
      await cleanupStaging(cwd)
    }
  })

  const summary: EvalReport['summary'] = []
  for (const testCase of spec.cases) {
    for (const check of testCase.checks) {
      // Rate is measured over runs where the check actually applied. A guarded
      // check that never triggered in an arm has no evidence there; counting its
      // vacuous passes against an all-runs denominator inflated such arms to
      // 100% and produced inverted deltas.
      const applicableRows = (arm: 'baseline' | 'skill') =>
        results
          .filter((r) => r.id === testCase.id && r.arm === arm)
          .filter((r) => r.checks.find((c) => c.id === check.id)?.applicable !== false)
      const rate = (arm: 'baseline' | 'skill'): number | null => {
        const rows = applicableRows(arm)
        if (rows.length === 0) return null // no evidence in this arm, not 0%
        const passed = rows.filter((r) => r.checks.find((c) => c.id === check.id)?.passed).length
        return passed / rows.length
      }
      const applicable = (arm: 'baseline' | 'skill') => applicableRows(arm).length
      const baseline = rate('baseline')
      const skill = rate('skill')
      summary.push({
        caseId: testCase.id,
        checkId: check.id,
        baseline,
        skill,
        // A delta needs both arms to have evidence.
        delta: baseline !== null && skill !== null ? skill - baseline : null,
        baselineApplicable: applicable('baseline'),
        skillApplicable: applicable('skill'),
      })
    }
  }

  // Mean over the checks that actually produced a rate in that arm.
  const mean = (arm: 'baseline' | 'skill') => {
    const vals = summary.map((r) => r[arm]).filter((v): v is number => v !== null)
    return vals.length === 0 ? 0 : vals.reduce((s, v) => s + v, 0) / vals.length
  }

  // Pool every applicable check outcome across all runs into one two-arm
  // comparison. Per-check n is tiny; pooled n is large enough to test.
  const outcomes = (arm: 'baseline' | 'skill') => {
    let passed = 0
    let total = 0
    for (const r of results.filter((x) => x.arm === arm)) {
      for (const c of r.checks) {
        if (c.applicable === false) continue
        total++
        if (c.passed) passed++
      }
    }
    return { passed, total }
  }
  const base = outcomes('baseline')
  const skl = outcomes('skill')
  const sig = twoProportion(base.passed, base.total, skl.passed, skl.total)

  const median = (arm: 'baseline' | 'skill'): number | null => {
    const xs = results
      .filter((r) => r.arm === arm)
      .map((r) => r.tokens)
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b)
    if (xs.length === 0) return null
    const mid = Math.floor(xs.length / 2)
    return xs.length % 2 ? (xs[mid] as number) : ((xs[mid - 1] as number) + (xs[mid] as number)) / 2
  }
  const bMed = median('baseline')
  const sMed = median('skill')

  return {
    spec,
    results,
    summary,
    baselineScore: mean('baseline'),
    skillScore: mean('skill'),
    significance: {
      ...sig,
      baseline: wilson(base.passed, base.total),
      skill: wilson(skl.passed, skl.total),
      baselinePassed: base.passed,
      skillPassed: skl.passed,
      total: base.total,
    },
    cost: {
      baselineMedian: bMed,
      skillMedian: sMed,
      delta: bMed !== null && sMed !== null ? sMed - bMed : null,
    },
    metrics: computeMetrics(results),
  }
}
