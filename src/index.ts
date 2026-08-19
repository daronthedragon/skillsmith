#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { runEval, type EvalSpec } from './eval.js'
import { ParseError, parseSkill } from './parse.js'
import { lint, RULES, type Finding } from './rules.js'
import { scaffoldEval, scaffoldSkill } from './scaffold.js'

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
    rules                     Print every lint rule and why it exists

  Options
    --json                    Machine-readable output
    --summary "<text>"        (new) One line on what the skill does
    --dir <path>              (new) Where to create it          (default ./<name>)
    -h, --help

  Examples
    skillsmith new prove-it --summary "Nothing is done until it has been run."
    skillsmith lint ~/.claude/skills/prove-it
    skillsmith eval prove-it/eval.json
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
      if (['summary', 'dir'].includes(body)) {
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
      ? c.green(`the skill changed behaviour: ${b}% → ${s}%`)
      : s === b
        ? c.yellow(`no measurable change: ${b}% → ${s}%. The skill is not doing anything.`)
        : c.red(`the skill made things worse: ${b}% → ${s}%`)
  out.push(`  ${verdict}`)
  out.push('')
  out.push(c.dim(`  ${report.results.length} runs. Transcripts are in the --json output.`))
  out.push('')
  process.stdout.write(out.join('\n'))
  return s > b ? 0 : 1
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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case 'lint':
      return cmdLint(args)
    case 'new':
      return cmdNew(args)
    case 'eval':
      return cmdEval(args)
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
