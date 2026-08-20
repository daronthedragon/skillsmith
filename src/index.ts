#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { computeMetrics, gateReport, runEval, type EvalReport, type EvalSpec } from './eval.js'
import { ParseError, parseSkill } from './parse.js'
import { lint, RULES, type Finding } from './rules.js'
import { scaffoldEval, scaffoldSkill } from './scaffold.js'
import { fmtInterval } from './stats.js'
import { installHook, previewPersist, removeHook } from './hook.js'
import { buildPersistText } from './persist.js'
import { homedir } from 'node:os'

const useColour = process.stdout.isTTY || process.env.FORCE_COLOR !== undefined
const paint = (code: string, t: string) => (useColour ? `[${code}m${t}[0m` : t)
const c = {
  bold: (t: string) => paint('1', t),
  dim: (t: string) => paint('2', t),
  red: (t: string) => paint('31', t),
  green: (t: string) => paint('32', t),
  yellow: (t: string) => paint('33', t),
  cyan: (t: string) => paint('36', t),
  magenta: (t: string) => paint('35', t),
}

/** How many failing transcripts --failures prints before summarising the rest. */
const FAILURE_LIMIT = 8

const USAGE = `
  skillsmith — build agent skills that demonstrably change behaviour

  Commands
    lint <SKILL.md|dir>       Check a skill against the rules that decide whether it can work
    new <name> [--oneshot]    Scaffold a skill that passes lint on day one, plus an eval spec
    eval <eval.json>          Run prompts with and without the skill; report the behaviour delta
    hook <skill-dir>          Install a UserPromptSubmit hook so the skill persists every turn
    persist <skill-dir>       Print the reminder the hook injects (what the runtime outputs)
    rules                     Print every lint rule and why it exists

  Options
    --json                    (lint, eval, rules) Machine-readable output
    --render                  (eval) Re-render a saved report, spending no calls
    --min-reduction <pct>     (eval) Fail unless the metric shrank at least this much
    --min-pass <pct>          (eval) Fail unless the skill arm's pass rate is at least this
    --failures                (eval) Print the transcripts of runs that failed a check
    --metric <name>           (eval) Which metric the gate reads (default "response length")
    --summary "<text>"        (new) One line on what the skill does
    --dir <path>              (new) Where to create it          (default ./<name>)
    --settings <path>         (hook) settings.json to edit    (default ~/.claude/settings.json)
    --remove                  (hook) Unwire the persistence hook
    --print                   (hook) Show what would be injected without installing
    -h, --help

  Examples
    skillsmith new prove-it --summary "Nothing is done until it has been run."
    skillsmith lint ~/.claude/skills/prove-it
    skillsmith eval prove-it/eval.json
    skillsmith eval terse/eval.json --min-reduction 50      # CI regression gate
    skillsmith hook ~/.claude/skills/prove-it
`

interface Args {
  command: string
  positional: string[]
  flags: Map<string, string | true>
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '-h' || a === '--help') {
      help = true
      continue
    }
    if (a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1))
        continue
      }
      const next = argv[i + 1]
      if (['summary', 'dir', 'settings', 'min-reduction', 'min-pass', 'metric'].includes(body)) {
        if (next === undefined || next.startsWith('--')) throw new Error(`--${body} needs a value`)
        flags.set(body, next)
        i++
      } else {
        flags.set(body, true)
      }
      continue
    }
    positional.push(a)
  }
  const command = positional.shift() ?? ''
  return { command, positional, flags, help }
}

async function resolveSkillFile(target: string): Promise<string> {
  const abs = resolve(target)
  const info = await stat(abs).catch(() => null)
  if (!info) throw new Error(`${target} does not exist`)
  if (info.isDirectory()) {
    const candidate = join(abs, 'SKILL.md')
    const candidateInfo = await stat(candidate).catch(() => null)
    if (!candidateInfo) throw new Error(`${target} has no SKILL.md`)
    if (!candidateInfo.isFile()) throw new Error(`${candidate} is not a file`)
    return candidate
  }
  return abs
}

function renderFindings(file: string, findings: Finding[], score: number): string {
  const out: string[] = ['']
  out.push(`  ${c.bold(c.magenta('skillsmith lint'))}  ${c.dim(file)}`)
  out.push('')
  if (findings.length === 0) {
    out.push(c.green('  No findings. This skill has the structure of one that works.'))
  } else {
    const order = { error: 0, warn: 1, info: 2 }
    const sorted = [...findings].sort((a, b) => order[a.level] - order[b.level])
    for (const f of sorted) {
      const badge =
        f.level === 'error' ? c.red('ERROR') : f.level === 'warn' ? c.yellow('WARN ') : c.dim('info ')
      const where = f.line ? c.dim(` :${f.line}`) : ''
      out.push(`  ${badge}  ${c.bold(f.rule)}${where}`)
      out.push(`         ${f.message}`)
      out.push(`         ${c.cyan('fix')} ${f.fix}`)
      out.push('')
    }
  }
  const tone = score >= 85 ? c.green : score >= 60 ? c.yellow : c.red
  out.push(`  score ${tone(c.bold(String(score)))}${c.dim('/100')}  ${c.dim('errors 25, warnings 8, info 3')}`)
  out.push('')
  return out.join('\n')
}

async function cmdLint(args: Args): Promise<number> {
  const target = args.positional[0]
  if (!target) throw new Error('lint needs a path to a SKILL.md or a skill directory')
  const file = await resolveSkillFile(target)
  const raw = await readFile(file, 'utf8')

  let result
  try {
    result = lint(parseSkill(raw))
  } catch (err) {
    if (err instanceof ParseError) {
      const f: Finding = { rule: 'parse', level: 'error', message: err.message, fix: 'Fix the frontmatter block first.', line: 1 }
      result = { findings: [f], errors: 1, warnings: 0, score: 0 }
    } else throw err
  }

  if (args.flags.has('json')) {
    process.stdout.write(JSON.stringify({ file, ...result }, null, 2) + '\n')
  } else {
    process.stdout.write(renderFindings(file, result.findings, result.score))
  }
  return result.errors > 0 ? 1 : 0
}

async function cmdNew(args: Args): Promise<number> {
  const name = args.positional[0]
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error('new needs a lowercase-hyphenated name, e.g. `skillsmith new prove-it`')
  }
  const summary = String(args.flags.get('summary') ?? `[ONE LINE: what ${name} does to the agent's behaviour.]`)
  const kind = args.flags.has('oneshot') ? 'oneshot' : 'mode'
  const dir = resolve(String(args.flags.get('dir') ?? name))

  await mkdir(dir, { recursive: true })
  const skillPath = join(dir, 'SKILL.md')
  if (await stat(skillPath).catch(() => null)) throw new Error(`${skillPath} already exists; not overwriting`)

  await writeFile(skillPath, scaffoldSkill({ name, summary, kind }), 'utf8')
  await writeFile(join(dir, 'eval.json'), scaffoldEval(name, 'SKILL.md') + '\n', 'utf8')

  process.stdout.write(`\n  created ${c.cyan(skillPath)}\n  created ${c.cyan(join(dir, 'eval.json'))}\n\n`)
  process.stdout.write(`  Next: replace every [BRACKETED] placeholder, then ${c.bold(`skillsmith lint ${dir}`)}\n\n`)
  return 0
}

/** Read and validate the gate flags, or null when no gate was asked for. */
function parseGate(args: Args): { minReduction?: number; metric?: string; minPass?: number } | null {
  const pct = (name: string): number | undefined => {
    const raw = args.flags.get(name)
    if (raw === undefined) return undefined
    if (raw === true) throw new Error(`--${name} needs a percentage, e.g. --${name} 50`)
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new Error(`--${name} must be a percentage between 0 and 100, got "${raw}"`)
    }
    return n
  }
  const minReduction = pct('min-reduction')
  const minPass = pct('min-pass')
  if (minReduction === undefined && minPass === undefined) return null
  const metricRaw = args.flags.get('metric')
  return { minReduction, minPass, metric: typeof metricRaw === 'string' ? metricRaw : undefined }
}

async function cmdEval(args: Args): Promise<number> {
  const specPath = args.positional[0]
  if (!specPath) throw new Error('eval needs a path to an eval.json')
  const gate = parseGate(args)

  // Re-render a saved report (the --json output) without spending any calls.
  if (args.flags.has('render')) {
    let report: EvalReport
    try {
      report = JSON.parse(await readFile(resolve(specPath), 'utf8')) as EvalReport
    } catch (err) {
      throw new Error(`${specPath} is not a readable report JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!Array.isArray(report.summary) || !report.significance) {
      throw new Error(`${specPath} is not a skillsmith eval report (run \`eval ... --json\` to produce one).`)
    }
    const rendered = renderEvalReport(report, args.flags.has('failures'))
    process.stdout.write(rendered.text)
    if (gate) {
      const g = gateReport(report, gate)
      process.stdout.write(`${g.line}\n\n`)
      return g.ok ? 0 : 1
    }
    return rendered.exitCode
  }

  const abs = resolve(specPath)

  const rawSpec = await readFile(abs, 'utf8').catch((err: NodeJS.ErrnoException) => {
    throw new Error(err.code === 'ENOENT' ? `${specPath} does not exist` : `Could not read ${specPath}: ${err.message}`)
  })
  let spec: EvalSpec
  try {
    spec = JSON.parse(rawSpec) as EvalSpec
  } catch (err) {
    throw new Error(`${specPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof spec !== 'object' || spec === null) throw new Error(`${specPath} must contain a JSON object`)
  if (typeof spec.runner !== 'string') throw new Error(`${specPath} is missing a "runner" string`)
  if (!Array.isArray(spec.cases) || spec.cases.length === 0) {
    throw new Error(`${specPath} needs a non-empty "cases" array`)
  }
  // A spec evaluates either a skill or an output style; paths are resolved
  // relative to the spec file.
  if (spec.outputStyle) {
    if (typeof spec.outputStyle.name !== 'string' || typeof spec.outputStyle.file !== 'string') {
      throw new Error(`${specPath} "outputStyle" needs a "name" and a "file"`)
    }
    spec.outputStyle.file = resolve(dirname(abs), spec.outputStyle.file)
    spec.skill = spec.skill ? resolve(dirname(abs), spec.skill) : spec.outputStyle.file
  } else {
    if (typeof spec.skill !== 'string') throw new Error(`${specPath} is missing a "skill" path`)
    spec.skill = resolve(dirname(abs), spec.skill)
  }

  if (/REPLACE/.test(spec.runner)) {
    throw new Error('eval.json still has the placeholder runner. Set `runner` to the command that runs one prompt.')
  }
  if (spec.cases.some((k) => /REPLACE/.test(k.prompt) || k.checks.some((ch) => /REPLACE/.test(ch.pattern)))) {
    throw new Error('eval.json still has REPLACE placeholders in a prompt or check pattern.')
  }

  const report = await runEval(spec, (line) => {
    if (!args.flags.has('json')) process.stderr.write(c.dim(`  ${line}\n`))
  })

  if (args.flags.has('json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    // A gate still decides the exit code in --json mode, so CI can capture the
    // report and enforce the threshold in one run instead of paying twice.
    return gate ? (gateReport(report, gate).ok ? 0 : 1) : 0
  }

  const rendered = renderEvalReport(report, args.flags.has('failures'))
  process.stdout.write(rendered.text)
  if (gate) {
    const g = gateReport(report, gate)
    process.stdout.write(`${g.line}\n\n`)
    return g.ok ? 0 : 1
  }
  return rendered.exitCode
}

/** Render an eval report as the terminal output. Shared by a live run and by
 * `--render`, which re-renders a saved report without spending a single call. */
function renderEvalReport(report: EvalReport, showFailures = false): { text: string; exitCode: number } {
  const out: string[] = ['']
  // A spec can legitimately carry no `skill` - an output-style eval names a
  // style file instead - and basename(undefined) throws, taking the whole
  // render down over a heading.
  const subject = report.spec.skill ?? report.spec.outputStyle?.file ?? report.spec.outputStyle?.name
  out.push(`  ${c.bold(c.magenta('skillsmith eval'))}  ${c.dim(subject ? basename(subject) : 'eval')}`)
  out.push('')

  // A run that never executed still has a transcript - the error text - and that
  // text scores like any reply: short, missing the expected words, "the skill
  // truncated the answer". This project misread its own benchmarks three times
  // that way (a killed timeout, a CLI that would not spawn, a broken install)
  // before this warning existed. Contamination is stated before any rate is.
  const failedBy = (arm: 'baseline' | 'skill') =>
    report.results.filter((r) => r.arm === arm && r.exitCode !== 0).length
  const failedSkill = failedBy('skill')
  const failedBaseline = failedBy('baseline')
  if (failedSkill + failedBaseline > 0) {
    const total = report.results.length
    out.push(
      c.red(
        `  WARNING  ${failedSkill + failedBaseline} of ${total} runs did not exit 0 ` +
          `(skill ${failedSkill}, baseline ${failedBaseline}).`,
      ),
    )
    out.push(
      c.red('           Their transcript is an error message, not a reply, so every rate below is contaminated.'),
    )
    out.push(c.dim('           Read them with --failures before believing any number here.'))
    out.push('')
  }
  out.push(`  ${'case / check'.padEnd(40)}${'without'.padStart(9)}${'with'.padStart(8)}${'delta'.padStart(9)}`)
  out.push(`  ${'─'.repeat(66)}`)
  // A guarded check that rarely triggered is worth flagging: a high pass rate
  // there can be mostly vacuous, not evidence the skill did anything.
  const guarded = report.summary.some((r) => r.baselineApplicable + r.skillApplicable > 0)
  for (const row of report.summary) {
    const pct = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 100)}%`).padStart(8)
    const delta = row.delta
    const d = delta === null ? 'n/a' : (delta >= 0 ? '+' : '') + `${Math.round(delta * 100)}%`
    const tone = delta === null ? c.dim : delta > 0 ? c.green : delta < 0 ? c.red : c.dim
    out.push(`  ${`${row.caseId} / ${row.checkId}`.padEnd(40)}${pct(row.baseline)} ${pct(row.skill)} ${tone(d.padStart(8))}`)
  }
  if (guarded) {
    out.push('')
    out.push(c.dim('  guarded checks (implication) only count runs that triggered the guard:'))
    for (const row of report.summary.filter((r) => r.baselineApplicable + r.skillApplicable > 0)) {
      const runs = report.results.filter((r) => r.id === row.caseId).length / 2
      out.push(
        c.dim(
          `    ${`${row.caseId} / ${row.checkId}`.padEnd(38)} triggered ${row.baselineApplicable}/${runs} without, ${row.skillApplicable}/${runs} with`,
        ),
      )
    }
  }
  out.push(`  ${'─'.repeat(66)}`)
  const b = Math.round(report.baselineScore * 100)
  const s = Math.round(report.skillScore * 100)
  const verdict =
    s > b
      ? c.green(`mean pass rate ${b}% → ${s}%`)
      : s === b
        ? c.yellow(`mean pass rate unchanged at ${b}%`)
        : c.red(`mean pass rate fell ${b}% → ${s}%`)
  out.push(`  ${verdict}`)

  // The number the mean cannot give you: is the difference real at this n?
  const sig = report.significance
  const pct = (n: number) => `${Math.round(n * 100)}%`
  const line =
    sig.significant && sig.delta > 0
      ? c.green(
          `significant: the skill's effect is real (p=${sig.p.toFixed(3)}, ${sig.total} outcomes/arm)`,
        )
      : sig.significant && sig.delta < 0
        ? c.red(
            `significant, but WORSE: the skill measurably hurts (p=${sig.p.toFixed(3)}, ${sig.total} outcomes/arm)`,
          )
      : sig.suggestMoreRuns
        ? c.yellow(
            `promising but unproven: +${pct(sig.delta)} could be noise at this sample ` +
              `(p=${sig.p.toFixed(2)}). Raise "repeat" and re-run.`,
          )
        : c.dim(`not distinguishable from noise (p=${sig.p.toFixed(2)})`)
  out.push(`  ${line}`)
  out.push(
    c.dim(
      `  95% CI  without ${fmtInterval(sig.baseline)}   with ${fmtInterval(sig.skill)}`,
    ),
  )

  // `cost` is absent entirely on a report from a runner that reports no usage,
  // so reach through it optionally rather than assuming the object is there.
  if (report.cost?.baselineMedian != null && report.cost?.skillMedian != null) {
    const d = report.cost.delta ?? 0
    const sign = d >= 0 ? '+' : ''
    const tone = d > report.cost.baselineMedian * 0.5 ? c.yellow : c.dim
    out.push(
      tone(
        `  cost    ${report.cost.baselineMedian.toLocaleString()} → ` +
          `${report.cost.skillMedian.toLocaleString()} tokens/run median ` +
          `(${sign}${d.toLocaleString()} for the skill)`,
      ),
    )
  }

  // Magnitude effects the pass/fail checks cannot see (shorter, cheaper).
  // Recomputed from the stored transcripts, so this shows on saved reports too.
  const metrics = computeMetrics(report.results)
  let metricWin = false
  for (const m of metrics) {
    const cmp = m.comparison
    const pctDelta = `${cmp.delta >= 0 ? '+' : ''}${Math.round(cmp.delta * 100)}%`
    const verdict = cmp.significant
      ? cmp.delta < 0
        ? c.green(`significant (p=${cmp.p.toFixed(3)})`)
        : c.red(`significant, larger (p=${cmp.p.toFixed(3)})`)
      : c.dim(`not significant (p=${cmp.p.toFixed(2)})`)
    if (cmp.significant && cmp.delta < 0) metricWin = true
    out.push(
      `  ${m.name.padEnd(16)}${Math.round(cmp.medianBaseline).toLocaleString()} → ` +
        `${Math.round(cmp.medianSkill).toLocaleString()} ${m.unit} median  ` +
        `${pctDelta}  ${verdict}`,
    )
  }

  // A percentage tells you a check failed; only the transcript tells you why -
  // and the answer is often that the check is wrong rather than the skill. Every
  // real failure in this project's own evals turned out to need this text, so it
  // is one flag away instead of a hand-written script over the JSON.
  if (showFailures) {
    const failed = report.results.filter(
      (r) => r.arm === 'skill' && r.checks.some((k) => k.passed === false && k.applicable !== false),
    )
    out.push('')
    if (failed.length === 0) {
      out.push(c.dim('  no failing runs in the skill arm.'))
    } else {
      out.push(c.bold(`  ${failed.length} failing run(s) in the skill arm:`))
      for (const r of failed.slice(0, FAILURE_LIMIT)) {
        const which = r.checks.filter((k) => !k.passed && k.applicable !== false).map((k) => k.id).join(', ')
        const body = r.transcript.trim().replace(/\s+/g, ' ')
        out.push('')
        out.push(`  ${c.red(r.id)} run ${r.run}  ${c.dim(`failed: ${which}`)}`)
        out.push(`    ${body.slice(0, 300)}${body.length > 300 ? c.dim(' …') : ''}`)
      }
      if (failed.length > FAILURE_LIMIT) {
        out.push('')
        out.push(c.dim(`  … and ${failed.length - FAILURE_LIMIT} more (all of them are in --json).`))
      }
    }
  }

  out.push('')
  out.push(c.dim(`  ${report.results.length} runs. Transcripts are in the --json output.`))
  out.push('')
  // Success when the skill helps on a pass-rate check OR significantly reduces a
  // magnitude metric (shorter, cheaper) - a real effect either way.
  const exitCode = (sig.significant && sig.delta > 0) || metricWin ? 0 : 1
  return { text: out.join('\n'), exitCode }
}

function cmdRules(args: Args): number {
  if (args.flags.has('json')) {
    process.stdout.write(JSON.stringify(RULES.map(({ id, level, why }) => ({ id, level, why })), null, 2) + '\n')
    return 0
  }
  const out: string[] = ['', `  ${c.bold(c.magenta('skillsmith rules'))}  ${c.dim('each one names a way a skill fails to work')}`, '']
  for (const r of RULES) {
    const badge = r.level === 'error' ? c.red('ERROR') : r.level === 'warn' ? c.yellow('WARN ') : c.dim('info ')
    out.push(`  ${badge}  ${c.bold(r.id)}`)
    out.push(`         ${c.dim(r.why)}`)
    out.push('')
  }
  process.stdout.write(out.join('\n'))
  return 0
}

/** Resolve a skill directory from either a directory or a SKILL.md path. */
async function skillDirOf(target: string): Promise<string> {
  const abs = resolve(target)
  const info = await stat(abs).catch(() => null)
  if (!info) throw new Error(`${target} does not exist`)
  const dir = info.isDirectory() ? abs : dirname(abs)
  if (!(await stat(join(dir, 'SKILL.md')).catch(() => null))) {
    throw new Error(`${dir} has no SKILL.md`)
  }
  return dir
}

const defaultSettings = () => join(homedir(), '.claude', 'settings.json')

async function cmdPersist(args: Args): Promise<number> {
  const target = args.positional[0]
  if (!target) throw new Error('persist needs a path to a skill directory or SKILL.md')
  process.stdout.write(await previewPersist(await skillDirOf(target)))
  return 0
}

async function cmdHook(args: Args): Promise<number> {
  const target = args.positional[0]
  if (!target) throw new Error('hook needs a path to a skill directory or SKILL.md')
  const skillDir = await skillDirOf(target)
  const settingsPath = String(args.flags.get('settings') ?? defaultSettings())

  if (args.flags.has('print')) {
    process.stdout.write('\n' + c.dim('  injected on every UserPromptSubmit:') + '\n\n')
    process.stdout.write(buildPersistText(await readFile(join(skillDir, 'SKILL.md'), 'utf8')))
    process.stdout.write('\n')
    return 0
  }

  if (args.flags.has('remove')) {
    const { removed } = await removeHook({ skillDir, settingsPath })
    process.stdout.write(
      removed
        ? `\n  ${c.green('removed')} the persistence hook from ${c.cyan(settingsPath)}\n\n`
        : `\n  ${c.dim('no persistence hook for this skill was present')}\n\n`,
    )
    return 0
  }

  const r = await installHook({ skillDir, settingsPath })
  const out: string[] = ['']
  out.push(`  ${c.bold(c.magenta('skillsmith hook'))}  ${c.dim(skillDir)}`)
  out.push('')
  out.push(`  runtime   ${c.cyan(r.scriptPath)}`)
  out.push(
    `  settings  ${c.cyan(r.settingsPath)}  ${r.added ? c.green('(hook added)') : c.dim('(already present)')}`,
  )
  out.push(`  wired     ${c.dim('UserPromptSubmit → ' + r.command)}`)
  out.push('')
  out.push(c.dim('  The skill is now re-asserted at the start of every turn. It costs a few'))
  out.push(c.dim('  tokens per prompt. Undo with `skillsmith hook <dir> --remove`.'))
  out.push('')
  process.stdout.write(out.join('\n'))
  return 0
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  // Help is a success, not an error: print usage and exit 0.
  if (args.help || args.command === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  if (!args.command) {
    process.stderr.write(USAGE)
    return 1
  }

  switch (args.command) {
    case 'lint':
      return cmdLint(args)
    case 'new':
      return cmdNew(args)
    case 'eval':
      return cmdEval(args)
    case 'hook':
      return cmdHook(args)
    case 'persist':
      return cmdPersist(args)
    case 'rules':
      return cmdRules(args)
    default:
      throw new Error(`Unknown command "${args.command}"\n${USAGE}`)
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`)
    process.exit(1)
  })
