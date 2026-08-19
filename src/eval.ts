import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * An eval is a set of prompts plus checks that can be scored from the
 * transcript text alone. No model-as-judge: a judge is another prompt whose
 * behaviour you cannot verify, and the whole point here is verification.
 */
export interface Check {
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
}

export interface CaseResult {
  id: string
  arm: 'baseline' | 'skill'
  run: number
  transcript: string
  checks: Array<{ id: string; passed: boolean; matches: number }>
  exitCode: number
}

export interface EvalReport {
  spec: EvalSpec
  results: CaseResult[]
  /** Per check: pass rate without the skill vs with it. */
  summary: Array<{ caseId: string; checkId: string; baseline: number; skill: number; delta: number }>
  /** Mean pass rate across all checks, both arms. */
  baselineScore: number
  skillScore: number
}

/**
 * Quote one argument for whatever shell spawn() will use. Node picks cmd.exe
 * on Windows, where a single quote is an ordinary character - POSIX quoting
 * there leaves cmd waiting on an unterminated token and the runner hangs.
 */
export function shellQuote(text: string): string {
  if (process.platform === 'win32') {
    // cmd.exe: double quotes, with embedded double quotes doubled and the
    // metacharacters cmd still interprets inside quotes neutralised.
    return `"${text.replace(/"/g, '""').replace(/[%!^]/g, '^$&')}"`
  }
  return `'${text.replace(/'/g, `'\\''`)}'`
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
      child.kill('SIGKILL')
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
    return { id: check.id, passed, matches }
  })
}

/**
 * Materialise a skills directory for one arm. The skill arm gets a copy of
 * SKILL.md under its own name; the baseline arm gets an empty directory, so
 * both arms see the same harness with only the skill varying.
 */
async function stageSkill(skillPath: string, arm: 'baseline' | 'skill'): Promise<string> {
  // Each arm gets a throwaway project directory. Agents that load project
  // skills from `<cwd>/.claude/skills/` pick the skill up simply by running
  // with this directory as cwd, which is what the `{skill}` placeholder is for
  // (e.g. `cd {skill} && claude -p {prompt}`). The baseline arm gets the same
  // layout with the skills folder empty, so the only difference between arms
  // is the skill.
  const dir = await mkdtemp(join(tmpdir(), `skillsmith-${arm}-`))
  const { mkdir } = await import('node:fs/promises')
  const skillsDir = join(dir, '.claude', 'skills')
  await mkdir(skillsDir, { recursive: true })
  if (arm === 'skill') {
    const raw = await readFile(skillPath, 'utf8')
    const name = /^name:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? 'skill-under-test'
    await mkdir(join(skillsDir, name), { recursive: true })
    await writeFile(join(skillsDir, name, 'SKILL.md'), raw, 'utf8')
  }
  return dir
}

export async function runEval(
  spec: EvalSpec,
  onProgress?: (line: string) => void,
): Promise<EvalReport> {
  const repeat = spec.repeat ?? 1
  const timeout = spec.timeoutMs ?? 180_000
  const results: CaseResult[] = []

  for (const arm of ['baseline', 'skill'] as const) {
    const skillsDir = await stageSkill(spec.skill, arm)
    try {
      for (const testCase of spec.cases) {
        for (let run = 1; run <= repeat; run++) {
          const command = spec.runner
            .replace('{prompt}', shellQuote(testCase.prompt))
            .replace('{skill}', shellQuote(skillsDir))
          onProgress?.(`${arm.padEnd(8)} ${testCase.id} run ${run}/${repeat}`)
          const { stdout, code } = await runCommand(command, timeout)
          results.push({
            id: testCase.id,
            arm,
            run,
            transcript: stdout,
            checks: scoreTranscript(stdout, testCase.checks),
            exitCode: code,
          })
        }
      }
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
    }
  }

  const summary: EvalReport['summary'] = []
  for (const testCase of spec.cases) {
    for (const check of testCase.checks) {
      const rate = (arm: 'baseline' | 'skill') => {
        const rows = results.filter((r) => r.id === testCase.id && r.arm === arm)
        if (rows.length === 0) return 0
        const passed = rows.filter((r) => r.checks.find((c) => c.id === check.id)?.passed).length
        return passed / rows.length
      }
      const baseline = rate('baseline')
      const skill = rate('skill')
      summary.push({ caseId: testCase.id, checkId: check.id, baseline, skill, delta: skill - baseline })
    }
  }

  const mean = (arm: 'baseline' | 'skill') =>
    summary.length === 0 ? 0 : summary.reduce((s, r) => s + r[arm], 0) / summary.length

  return { spec, results, summary, baselineScore: mean('baseline'), skillScore: mean('skill') }
}
