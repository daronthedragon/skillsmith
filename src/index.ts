#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { runEval, type EvalSpec } from './eval.js'
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
    --json                    Machine-readable output
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
    skillsmith hook ~/.claude/skills/prove-it
`

interface Args {
  command: string
  positional: string[]
  flags: Map<string, string | true>
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '-h' || a === '--help') throw new Error(USAGE.trim())
    if (a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1))
        continue
      }
      const next = argv[i + 1]
      if (['summary', 'dir', 'settings'].includes(body)) {
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
  const command = positional.shift()
  if (!command) throw new Error(USAGE.trim())
  return { command, positional, flags }
}

async function resolveSkillFile(target: string): Promise<string> {
  const abs = resolve(target)
  const info = await stat(abs).catch(() => null)
  if (!info) throw new Error(`${target} does not exist`)
  if (info.isDirectory()) {
    const candidate = join(abs, 'SKILL.md')
    if (!(await stat(candidate).catch(() => null))) throw new Error(`${target} has no SKILL.md`)
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

async function cmdEval(args: Args): Promise<number> {
  const specPath = args.positional[0]
  if (!specPath) throw new Error('eval needs a path to an eval.json')
  const abs = resolve(specPath)
  const spec = JSON.parse(await readFile(abs, 'utf8')) as EvalSpec
  // Skill path in the spec is relative to the spec file.
  spec.skill = resolve(dirname(abs), spec.skill)

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
    return 0
  }

  const out: string[] = ['']
  out.push(`  ${c.bold(c.magenta('skillsmith eval'))}  ${c.dim(basename(spec.skill))}`)
  out.push('')
  out.push(`  ${'case / check'.padEnd(40)}${'without'.padStart(9)}${'with'.padStart(8)}${'delta'.padStart(9)}`)
  out.push(`  ${'─'.repeat(66)}`)
  // A guarded check that rarely triggered is worth flagging: a high pass rate
  // there can be mostly vacuous, not evidence the skill did anything.
  const guarded = report.summary.some((r) => r.baselineApplicable + r.skillApplicable > 0)
  for (const row of report.summary) {
    const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(8)
    const delta = row.delta
    const d = (delta >= 0 ? '+' : '') + `${Math.round(delta * 100)}%`
    const tone = delta > 0 ? c.green : delta < 0 ? c.red : c.dim
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
    sig.significant
      ? c.green(
          `significant: the skill's effect is real (p=${sig.p.toFixed(3)}, ${sig.total} outcomes/arm)`,
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

  if (report.cost.baselineMedian !== null && report.cost.skillMedian !== null) {
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

  out.push('')
  out.push(c.dim(`  ${report.results.length} runs. Transcripts are in the --json output.`))
  out.push('')
  process.stdout.write(out.join('\n'))
  // Exit success only when the improvement is real, not merely positive.
  return sig.significant && sig.delta > 0 ? 0 : 1
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
