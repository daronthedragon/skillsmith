import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeMetrics, gateReport, parseOutputTokens, parseTokens, runEval, scoreTranscript, shellQuote, type CaseResult, type EvalReport, type EvalSpec } from './eval.js'
import { ParseError, parseSkill } from './parse.js'
import { lint, RULES } from './rules.js'
import { scaffoldEval, scaffoldSkill } from './scaffold.js'

// ------------------------------------------------------------------ fixtures

/** A skill with every structural property the rules look for. */
const GOOD = `---
name: example-good
description: >
  Forces the agent to run code before claiming it works. Use whenever the user
  asks to implement, fix, or change code, or says "prove it". Stays active
  across turns. Do NOT use for pure explanation or prose tasks.
---

# Example Good

## Persistence

ACTIVE EVERY RESPONSE once triggered. Off only when the user says "stop example-good".

## Procedure

1. Before saying done, run the relevant command.
2. Paste the command and its output.
3. If it cannot be run, write "unverified" in the summary.

## Rules

- Never write "should work".
- Every claim carries its command.

## Example

Instead of: "Fixed, should work now."
Do: "Fixed. \`npm test\` → 12 passing."

## Observable effect

Count of "should work" drops to zero; every completion message contains a command.
`

/** Adjectives in a trench coat: the skill that does nothing. */
const VIBES = `---
name: vibes
description: Helps you write better code.
---

# Vibes

This skill helps you write high-quality, robust, clean code following best practices.
Try to be helpful and consider edge cases where possible. Generally aim for excellence.
`

// -------------------------------------------------------------------- parse

test('parses frontmatter scalars, quoted values and folded blocks', () => {
  const raw = `---
name: x
license: "MIT"
description: >
  line one
  line two
---
body`
  const p = parseSkill(raw)
  assert.equal(p.frontmatter.name, 'x')
  assert.equal(p.frontmatter.license, 'MIT')
  assert.equal(p.frontmatter.description, 'line one line two')
  assert.equal(p.body.trim(), 'body')
})

test('a folded description keeps text after a blank line (paragraph 2)', () => {
  const raw = `---
name: x
description: >
  Reviews pull requests for correctness.

  Use whenever the user asks to review a PR. Do NOT use for style nitpicks.
---
body`
  const p = parseSkill(raw)
  assert.match(p.frontmatter.description ?? '', /Use whenever the user asks to review a PR/)
  assert.match(p.frontmatter.description ?? '', /Do NOT use for style nitpicks/)
})

test('a --- horizontal rule inside an indented folded value is not the frontmatter end', () => {
  const raw = `---
name: x
description: >
  Some text.
  ---
  More text after a rule.
---
# Real Body`
  const p = parseSkill(raw)
  assert.equal(p.frontmatter.name, 'x')
  assert.match(p.frontmatter.description ?? '', /More text after a rule/)
  assert.match(p.body, /# Real Body/)
})

test('splits the body into headed sections and keeps line numbers', () => {
  const p = parseSkill(GOOD)
  const headings = p.sections.map((s) => s.heading)
  assert.ok(headings.includes('Procedure'))
  assert.ok(headings.includes('Observable effect'))
  const proc = p.sections.find((s) => s.heading === 'Procedure')!
  assert.ok(proc.line > 1)
  assert.match(proc.body, /1\. Before saying done/)
})

test('does not treat # inside a code fence as a heading', () => {
  const raw = `---
name: x
description: d
---
\`\`\`
# not a heading
\`\`\`
## Real`
  const p = parseSkill(raw)
  assert.deepEqual(
    p.sections.map((s) => s.heading).filter(Boolean),
    ['Real'],
  )
})

test('rejects a file with no frontmatter, clearly', () => {
  assert.throws(() => parseSkill('# just markdown'), ParseError)
  assert.throws(() => parseSkill('---\nname: x\n'), /never closed/)
})

test('tolerates CRLF', () => {
  const p = parseSkill(GOOD.replace(/\n/g, '\r\n'))
  assert.equal(p.frontmatter.name, 'example-good')
})

// --------------------------------------------------------------------- lint

test('a well-built skill passes with no findings', () => {
  const r = lint(parseSkill(GOOD))
  assert.deepEqual(r.findings.map((f) => f.rule), [], JSON.stringify(r.findings, null, 2))
  assert.equal(r.score, 100)
})

test('adjectives-in-a-trench-coat fails on the rules that matter', () => {
  const r = lint(parseSkill(VIBES))
  const ids = new Set(r.findings.map((f) => f.rule))
  assert.ok(ids.has('ordered-procedure'), 'no numbered steps')
  assert.ok(ids.has('frontmatter-description'), 'description says nothing about when')
  assert.ok(ids.has('no-adjective-soup'), 'quality words carry no instruction')
  assert.ok(ids.has('no-hedging'), '"try to", "consider", "where possible"')
  assert.ok(ids.has('no-self-reference'), 'talks about itself')
  assert.ok(r.errors >= 2)
  assert.ok(r.score < 40, `score ${r.score}`)
})

test('a behavioural skill mentioning "generate" is not wrongly exempted from persistence', () => {
  const raw = `---
name: styler
description: >
  Ensures every response you generate follows the house style. Use whenever the
  user is writing prose. Do NOT use for code.
---
# Styler
## Procedure
1. Read the draft.
2. Apply the house style.
3. Return it.
`
  const ids = lint(parseSkill(raw)).findings.map((f) => f.rule)
  assert.ok(ids.includes('persistence'), '"generate" must no longer exempt a persistent skill')
  assert.ok(ids.includes('off-switch'))
})

test('an incidental "do not use" in the body is not accepted as negative scope', () => {
  const raw = `---
name: x
description: >
  A helper. Use whenever the user asks for the thing that this does for them here.
---
# X
## Procedure
1. Do the thing.
2. Then the next thing.
3. Finish.
## Rules
- Do not use tabs for indentation in code samples.
`
  const ids = lint(parseSkill(raw)).findings.map((f) => f.rule)
  assert.ok(ids.includes('negative-scope'), 'body-only "do not use" is not a scope statement')
})

test('hedges in the description are caught, not just the body', () => {
  const raw = `---
name: x
description: >
  Try to help where possible, consider the context, and generally do the right
  thing as needed. Use whenever the user asks.
---
# X
## Procedure
1. Step one.
2. Step two.
3. Step three.
`
  const ids = lint(parseSkill(raw)).findings.map((f) => f.rule)
  assert.ok(ids.includes('no-hedging'), 'the description is scanned for hedges')
})

test('a numbered list inside a fence is not counted as a procedure', () => {
  const raw = `---
name: x
description: >
  A thing. Use whenever the user asks for it, in the situations it applies to.
---
# X
No real procedure here, just sample output:
\`\`\`
1. did a thing
2. did another
3. and a third
\`\`\`
`
  const ids = lint(parseSkill(raw)).findings.map((f) => f.rule)
  assert.ok(ids.includes('ordered-procedure'), 'fenced numbered output must not satisfy the procedure rule')
})

test('a one-shot skill is not penalised for lacking persistence or an off switch', () => {
  const oneshot = GOOD.replace('Stays active\n  across turns.', 'One-shot: produce a report and end.')
    .replace(/## Persistence[\s\S]*?## Procedure/, '## Procedure')
  const r = lint(parseSkill(oneshot))
  const ids = r.findings.map((f) => f.rule)
  assert.ok(!ids.includes('persistence'), ids.join(','))
  assert.ok(!ids.includes('off-switch'), ids.join(','))
})

test('every finding carries an actionable fix', () => {
  const r = lint(parseSkill(VIBES))
  for (const f of r.findings) {
    assert.ok(f.fix.length > 20, `${f.rule} has no real fix text`)
    assert.ok(f.message.length > 10, `${f.rule} has no real message`)
  }
})

test('every rule states why it exists', () => {
  for (const r of RULES) assert.ok(r.why.length > 40, `${r.id} has no why`)
})

test('hedging rule tolerates a couple of hedges and flags a pattern', () => {
  const two = GOOD.replace('- Never write "should work".', '- Try to avoid "should work" where possible.')
  assert.ok(!lint(parseSkill(two)).findings.some((f) => f.rule === 'no-hedging'))

  const many = GOOD + '\n- Try to consider this where possible, as needed, if possible, generally.\n'
  assert.ok(lint(parseSkill(many)).findings.some((f) => f.rule === 'no-hedging'))
})

test('flags a description that is a label rather than a trigger', () => {
  const short = GOOD.replace(/description: >[\s\S]*?---/, 'description: Runs code.\n---')
  const r = lint(parseSkill(short))
  const d = r.findings.filter((f) => f.rule === 'frontmatter-description')
  assert.ok(d.length >= 1)
  assert.ok(d.some((f) => /label/.test(f.message)))
})

// ----------------------------------------------------------------- scaffold

test('the scaffold passes its own linter apart from placeholders being placeholders', () => {
  const raw = scaffoldSkill({ name: 'demo-mode', summary: 'Makes the agent do a specific thing.', kind: 'mode' })
  const r = lint(parseSkill(raw))
  // Placeholders are bracketed text; they satisfy structure, not content.
  assert.equal(r.errors, 0, JSON.stringify(r.findings, null, 2))
  assert.match(raw, /ACTIVE EVERY RESPONSE/)
  assert.match(raw, /Do NOT use for/)
  assert.ok((raw.match(/^\d+\. /gm) ?? []).length >= 4)
})

test('the one-shot scaffold omits persistence and says one-shot', () => {
  const raw = scaffoldSkill({ name: 'demo-shot', summary: 'Produces a thing.', kind: 'oneshot' })
  assert.ok(!/ACTIVE EVERY RESPONSE/.test(raw))
  assert.match(raw, /One-shot/)
  assert.equal(lint(parseSkill(raw)).errors, 0)
})

test('scaffolded eval is valid JSON with loud placeholders', () => {
  const spec = JSON.parse(scaffoldEval('demo', 'SKILL.md')) as EvalSpec
  assert.equal(spec.skill, 'SKILL.md')
  assert.match(spec.runner, /REPLACE/)
  assert.ok(spec.cases.length >= 1)
  assert.ok(spec.cases[0]!.checks.length >= 2)
})

// --------------------------------------------------------------------- eval

test('an implication guard makes a check vacuously pass when the trigger is absent', () => {
  // "when you claim success, a run must be present"
  const check = {
    id: 'backed',
    describe: '',
    given: '\\b(works|correct)\\b',
    pattern: '"name":"Bash"',
    expect: true,
  }
  // No claim of success at all -> vacuously satisfied, not applicable.
  const quiet = scoreTranscript('I wrote the function.', [check])[0]!
  assert.equal(quiet.passed, true)
  assert.equal(quiet.applicable, false)

  // Claims success but shows no run -> the guard bites and it fails.
  const unbacked = scoreTranscript('This works, done.', [check])[0]!
  assert.equal(unbacked.applicable, true)
  assert.equal(unbacked.passed, false)

  // Claims success and a run is present -> passes.
  const backed = scoreTranscript('This works. {"name":"Bash"}', [check])[0]!
  assert.equal(backed.applicable, true)
  assert.equal(backed.passed, true)
})

test('parseTokens uses the result event as the authoritative total', () => {
  // Claude Code echoes the same call's usage in each assistant event and again
  // in the result event; the result carries the cumulative total. Summing every
  // occurrence would triple-count.
  const stream = [
    '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":5}}}',
    '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":5}}}',
    '{"type":"result","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100}}',
  ].join('\n')
  assert.equal(parseTokens(stream), 115, 'the result total, not 3x the message usage')
})

test('parseTokens does not truncate a usage object that nests other objects', () => {
  // A regex stopping at the first "}" drops output_tokens after a nested object.
  const line =
    '{"type":"result","usage":{"input_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":7486},"cache_creation_input_tokens":7486,"output_tokens":300}}'
  assert.equal(parseTokens(line), 10 + 7486 + 300)
})

test('parseTokens falls back to message usage when there is no result event', () => {
  const stream = [
    '{"type":"assistant","message":{"usage":{"input_tokens":40,"output_tokens":8}}}',
  ].join('\n')
  assert.equal(parseTokens(stream), 48)
})

test('parseTokens returns null when the transcript carries no usage', () => {
  assert.equal(parseTokens('plain text output, no json'), null)
  assert.equal(parseTokens('{"type":"result"}'), null)
})

test('parseOutputTokens reads only the output_tokens from the result event', () => {
  const stream = [
    '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":99}}}',
    '{"type":"result","usage":{"input_tokens":10,"output_tokens":42,"cache_read_input_tokens":500}}',
  ].join('\n')
  assert.equal(parseOutputTokens(stream), 42)
  assert.equal(parseOutputTokens('no json here'), null)
})

test('computeMetrics measures a response-length difference the checks cannot see', () => {
  // Both arms pass their checks identically, but the skill arm is much shorter.
  const mk = (arm: 'baseline' | 'skill', text: string): CaseResult => ({
    id: 'c',
    arm,
    run: 1,
    transcript: text,
    checks: [{ id: 'x', passed: true, matches: 1, applicable: true }],
    exitCode: 0,
    tokens: null,
  })
  const long = 'x'.repeat(1200)
  const short = 'x'.repeat(500)
  const results = [
    ...Array.from({ length: 8 }, () => mk('baseline', long)),
    ...Array.from({ length: 8 }, () => mk('skill', short)),
  ]
  const metrics = computeMetrics(results)
  const len = metrics.find((m) => m.name === 'response length')!
  assert.ok(len, 'a response-length metric is produced')
  assert.ok(len.comparison.delta < -0.3, `skill should be much shorter, got ${len.comparison.delta}`)
  assert.equal(len.comparison.medianBaseline, 1200)
  assert.equal(len.comparison.medianSkill, 500)
})

test('shellQuote does not bake stray carets into a Windows prompt', () => {
  if (process.platform !== 'win32') return
  // Inside cmd.exe double quotes, ^ and ! are literal; escaping them corrupts
  // the prompt the model receives.
  assert.equal(shellQuote('100% done, wow!'), '"100% done, wow!"')
  assert.equal(shellQuote('a "quoted" bit'), '"a ""quoted"" bit"')
})

test('shellQuote rejects a newline on Windows rather than silently dropping it', () => {
  if (process.platform !== 'win32') return
  assert.throws(() => shellQuote('line one\nline two'), /newline/)
})

test('runEval fails fast on an invalid check regex instead of aborting mid-run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-test-'))
  try {
    await writeFile(join(dir, 'SKILL.md'), GOOD, 'utf8')
    const spec: EvalSpec = {
      skill: join(dir, 'SKILL.md'),
      runner: 'echo hi',
      cases: [{ id: 'c', prompt: 'p', checks: [{ id: 'bad', describe: '', pattern: '(unterminated', expect: true }] }],
    }
    await assert.rejects(() => runEval(spec), /invalid pattern regex/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runEval rejects a spec with no cases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-test-'))
  try {
    await writeFile(join(dir, 'SKILL.md'), GOOD, 'utf8')
    await assert.rejects(
      () => runEval({ skill: join(dir, 'SKILL.md'), runner: 'echo hi', cases: [] }),
      /no cases/i,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scoreTranscript honours expect, min and max', () => {
  const t = 'ran npm test\nran npm test\nshould work'
  const r = scoreTranscript(t, [
    { id: 'has-test', describe: '', pattern: 'npm test', expect: true },
    { id: 'two-tests', describe: '', pattern: 'npm test', expect: true, min: 2 },
    { id: 'three-tests', describe: '', pattern: 'npm test', expect: true, min: 3 },
    { id: 'no-hedge', describe: '', pattern: 'should work', expect: false },
    { id: 'hedge-budget', describe: '', pattern: 'should work', expect: false, max: 1 },
  ])
  const by = Object.fromEntries(r.map((x) => [x.id, x.passed]))
  assert.equal(by['has-test'], true)
  assert.equal(by['two-tests'], true)
  assert.equal(by['three-tests'], false)
  assert.equal(by['no-hedge'], false)
  assert.equal(by['hedge-budget'], true)
})

test('runEval stages the skill only in the skill arm and reports a real delta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-test-'))
  try {
    const skillPath = join(dir, 'SKILL.md')
    await writeFile(skillPath, GOOD, 'utf8')

    // A fake runner: if the staged skills dir contains a SKILL.md, it "obeys"
    // the skill and prints a command; otherwise it prints a hedge. This
    // exercises the staging, the arms, the scoring and the summary without
    // needing a model, and the delta it produces is the delta the harness
    // must be able to measure.
    const fake = join(dir, 'fake-runner.mjs')
    await writeFile(
      fake,
      `import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [prompt, skillsDir] = process.argv.slice(2);
const sk = join(skillsDir, '.claude', 'skills');
const hasSkill = existsSync(sk) && readdirSync(sk).some((d) => existsSync(join(sk, d, 'SKILL.md')));
if (hasSkill) console.log('Fixed. Ran: npm test -> 12 passing. ' + prompt);
else console.log('Fixed, should work now. ' + prompt);
`,
      'utf8',
    )

    const spec: EvalSpec = {
      skill: skillPath,
      runner: `node ${JSON.stringify(fake)} {prompt} {skill}`,
      repeat: 2,
      timeoutMs: 30_000,
      cases: [
        {
          id: 'fix-bug',
          prompt: 'fix the failing test',
          checks: [
            { id: 'runs-command', describe: 'shows a command', pattern: 'Ran: ', expect: true },
            { id: 'no-should-work', describe: 'drops the hedge', pattern: 'should work', expect: false },
          ],
        },
      ],
    }

    const report = await runEval(spec)
    assert.equal(report.results.length, 4, 'two arms x two runs')
    assert.equal(report.baselineScore, 0, 'baseline fails both checks')
    assert.equal(report.skillScore, 1, 'skill arm passes both checks')
    const runs = report.summary.find((s) => s.checkId === 'runs-command')!
    assert.equal(runs.delta, 1)
    // A perfect 0/4 vs 4/4 split is significant even at this small n.
    assert.equal(report.significance.significant, true)
    assert.ok(report.significance.delta > 0)
    assert.equal(report.significance.total, 4, 'pooled outcomes per arm')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a staging directory that cannot be deleted does not destroy the run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-test-'))
  try {
    await writeFile(join(dir, 'SKILL.md'), GOOD, 'utf8')
    // The runner leaves a file open inside its own staging dir and keeps the
    // handle past its own exit on Windows; on POSIX this still exercises the
    // path where cleanup is attempted after the run produced a real result.
    const runner = join(dir, 'holder.mjs')
    await writeFile(
      runner,
      `import { openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const cwd = process.argv[3];
const f = join(cwd, 'held.txt');
writeFileSync(f, 'x');
openSync(f, 'r');            // deliberately never closed
console.log('ok');
`,
      'utf8',
    )
    const spec: EvalSpec = {
      skill: join(dir, 'SKILL.md'),
      runner: `node ${JSON.stringify(runner)} {prompt} {skill}`,
      repeat: 2,
      timeoutMs: 30_000,
      cases: [{ id: 'c', prompt: 'p', checks: [{ id: 'ok', describe: '', pattern: 'ok', expect: true }] }],
    }
    // The contract: runEval resolves with every result, whatever cleanup did.
    const report = await runEval(spec)
    assert.equal(report.results.length, 4, 'all four runs survived cleanup')
    assert.ok(report.results.every((r) => r.transcript.includes('ok')), 'transcripts intact')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('the regression gate passes a real reduction and fails a shrunken one', async () => {
  const mk = (arm: 'baseline' | 'skill', len: number, i: number): CaseResult => ({
    id: 'c',
    arm,
    run: i,
    transcript: 'x'.repeat(len),
    checks: [],
    exitCode: 0,
    tokens: null,
  })
  // A clean 1000 -> 300 chars split: -70%, and separated enough to be significant.
  const strong = {
    results: [
      ...Array.from({ length: 10 }, (_, i) => mk('baseline', 1000 + i, i)),
      ...Array.from({ length: 10 }, (_, i) => mk('skill', 300 + i, i)),
    ],
  } as unknown as EvalReport

  const pass = gateReport(strong, { minReduction: 50, metric: 'response length' })
  assert.equal(pass.ok, true, 'a -70% reduction clears a -50% gate')
  assert.match(pass.line, /PASS/)

  const tooHigh = gateReport(strong, { minReduction: 80, metric: 'response length' })
  assert.equal(tooHigh.ok, false, 'the same -70% fails an -80% gate')
  assert.match(tooHigh.line, /FAIL/)

  // A skill that stopped working: the arms overlap, so nothing is significant.
  const dead = {
    results: [
      ...Array.from({ length: 10 }, (_, i) => mk('baseline', 1000 + i, i)),
      ...Array.from({ length: 10 }, (_, i) => mk('skill', 1000 + i, i)),
    ],
  } as unknown as EvalReport
  const regressed = gateReport(dead, { minReduction: 50, metric: 'response length' })
  assert.equal(regressed.ok, false, 'no effect must fail the gate')
  assert.match(regressed.line, /NOT significant/)

  const missing = gateReport(strong, { minReduction: 50, metric: 'nonexistent' })
  assert.equal(missing.ok, false, 'an unknown metric fails loudly rather than passing vacuously')
  assert.match(missing.line, /no metric named/)

  // A pass-rate floor is the gate a safety benchmark needs: the skill is not
  // meant to beat the baseline there, only to avoid breaking it.
  const scored = { ...strong, skillScore: 0.97 } as unknown as EvalReport
  assert.equal(gateReport(scored, { minPass: 95 }).ok, true, '97% clears a 95% floor')
  const under = gateReport({ ...scored, skillScore: 0.8 } as unknown as EvalReport, { minPass: 95 })
  assert.equal(under.ok, false, '80% fails a 95% floor')
  assert.match(under.line, /skill pass rate 80% vs 95% required  FAIL/)

  // Both gates together: the reduction passes but the floor does not.
  const both = gateReport({ ...scored, skillScore: 0.5 } as unknown as EvalReport, {
    minReduction: 50,
    minPass: 95,
  })
  assert.equal(both.ok, false, 'one failing gate fails the whole run')
  assert.match(both.line, /PASS[\s\S]*FAIL/, 'both gate lines are reported')
})

test('runEval times every run and reports wall clock as a metric', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-test-'))
  try {
    await writeFile(join(dir, 'SKILL.md'), GOOD, 'utf8')
    // The skill arm sleeps measurably longer than the baseline, so a correct
    // implementation must report a positive wall-clock delta (skill is slower).
    const runner = join(dir, 'slow-runner.mjs')
    await writeFile(
      runner,
      `import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const sk = join(process.argv[3], '.claude', 'skills');
const hasSkill = existsSync(sk) && readdirSync(sk).some((d) => existsSync(join(sk, d, 'SKILL.md')));
const until = Date.now() + (hasSkill ? 260 : 20);
while (Date.now() < until) {}
console.log('ok');
`,
      'utf8',
    )
    const spec: EvalSpec = {
      skill: join(dir, 'SKILL.md'),
      runner: `node ${JSON.stringify(runner)} {prompt} {skill}`,
      repeat: 3,
      concurrency: 1,
      timeoutMs: 30_000,
      cases: [{ id: 'c', prompt: 'p', checks: [{ id: 'ok', describe: '', pattern: 'ok', expect: true }] }],
    }
    const report = await runEval(spec)
    assert.ok(
      report.results.every((r) => typeof r.durationMs === 'number' && r.durationMs >= 0),
      'every run carries a duration',
    )
    const wall = computeMetrics(report.results).find((m) => m.name === 'wall clock')
    assert.ok(wall, 'wall clock is reported as a metric')
    assert.equal(wall.unit, 'ms')
    assert.ok(
      wall.comparison.medianSkill > wall.comparison.medianBaseline,
      `the slower arm must read slower (baseline ${wall.comparison.medianBaseline}, skill ${wall.comparison.medianSkill})`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runEval stages an output style (file + settings) only in the skill arm', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-test-'))
  try {
    // The shipped artifact for an output-style skill: a style file that gets
    // copied into .claude/output-styles/ and switched on via settings.json.
    const stylePath = join(dir, 'terse.md')
    await writeFile(
      stylePath,
      '---\nname: terse\ndescription: answer first\n---\nAnswer first, cut the padding.\n',
      'utf8',
    )

    // A fake runner that "obeys" only when it sees the style staged AND turned
    // on in settings — exactly the two things stageRun must do, and only in the
    // skill arm. Otherwise it hedges.
    const fake = join(dir, 'style-runner.mjs')
    await writeFile(
      fake,
      `import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const [prompt, cwd] = process.argv.slice(2);
const style = join(cwd, '.claude', 'output-styles', 'terse.md');
const settings = join(cwd, '.claude', 'settings.json');
let on = false;
if (existsSync(style) && existsSync(settings)) {
  const s = JSON.parse(readFileSync(settings, 'utf8'));
  on = s.outputStyle === 'terse' && readFileSync(style, 'utf8').includes('cut the padding');
}
console.log(on ? 'Done. Ran: check. ' + prompt : 'Sure, this should work. ' + prompt);
`,
      'utf8',
    )

    const spec: EvalSpec = {
      outputStyle: { name: 'terse', file: stylePath },
      runner: `node ${JSON.stringify(fake)} {prompt} {skill}`,
      repeat: 2,
      timeoutMs: 30_000,
      cases: [
        {
          id: 'style',
          prompt: 'explain chmod',
          checks: [
            { id: 'applied', describe: 'style was active', pattern: 'Ran: ', expect: true },
            { id: 'no-hedge', describe: 'drops the hedge', pattern: 'should work', expect: false },
          ],
        },
      ],
    }

    const report = await runEval(spec)
    assert.equal(report.results.length, 4, 'two arms x two runs')
    assert.equal(report.baselineScore, 0, 'baseline has no style staged, so it hedges')
    assert.equal(report.skillScore, 1, 'skill arm sees the style + settings and obeys')
    assert.equal(report.significance.significant, true, '0/4 vs 4/4 is significant')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a guarded check the baseline never triggers reports null, not a fake delta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-test-'))
  try {
    await writeFile(join(dir, 'SKILL.md'), GOOD, 'utf8')
    // The runner emits the guard trigger only in the skill arm.
    const runner = join(dir, 'arm-runner.mjs')
    await writeFile(
      runner,
      `import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const sk = join(process.argv[3], '.claude', 'skills');
const hasSkill = existsSync(sk) && readdirSync(sk).some((d) => existsSync(join(sk, d, 'SKILL.md')));
console.log(hasSkill ? 'CLAIMED and PROOF here' : 'nothing to see');
`,
      'utf8',
    )
    const spec: EvalSpec = {
      skill: join(dir, 'SKILL.md'),
      runner: `node ${JSON.stringify(runner)} {prompt} {skill}`,
      repeat: 2,
      timeoutMs: 30_000,
      cases: [
        {
          id: 'guarded',
          prompt: 'p',
          checks: [{ id: 'g', describe: '', given: 'CLAIMED', pattern: 'PROOF', expect: true }],
        },
      ],
    }
    const report = await runEval(spec)
    const row = report.summary.find((r) => r.checkId === 'g')!
    assert.equal(row.baseline, null, 'baseline never triggered the guard, so it has no rate')
    assert.equal(row.baselineApplicable, 0)
    assert.equal(row.skill, 1, 'skill triggered and passed')
    assert.equal(row.delta, null, 'no delta without both arms - not a fake -100%/+100%')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runEval isolates each run in its own working directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-test-'))
  try {
    await writeFile(join(dir, 'SKILL.md'), GOOD, 'utf8')
    // A runner that appends its cwd to a shared log, so we can see whether two
    // runs in the same arm ever shared one.
    const runner = join(dir, 'cwd-runner.mjs')
    await writeFile(
      runner,
      `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(dir, 'cwds.txt'))}, process.cwd() + "\\n");
console.log("ok");
`,
      'utf8',
    )
    const spec: EvalSpec = {
      skill: join(dir, 'SKILL.md'),
      // The runner ignores {prompt}; {skill} is the staged cwd we cd into.
      runner: `cd {skill} && node ${JSON.stringify(runner)} {prompt}`,
      repeat: 3,
      concurrency: 2,
      timeoutMs: 30_000,
      cases: [{ id: 'c', prompt: 'p', checks: [{ id: 'ok', describe: '', pattern: 'ok', expect: true }] }],
    }
    await runEval(spec)
    const { readFileSync } = await import('node:fs')
    const cwds = readFileSync(join(dir, 'cwds.txt'), 'utf8').trim().split('\n')
    assert.equal(cwds.length, 6, 'two arms x three runs each executed')
    assert.equal(new Set(cwds).size, 6, 'every run had a distinct working directory')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runEval tolerates a runner that fails, and scores what it got', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-test-'))
  try {
    const skillPath = join(dir, 'SKILL.md')
    await writeFile(skillPath, GOOD, 'utf8')
    const spec: EvalSpec = {
      skill: skillPath,
      runner: 'node -e "process.exit(3)" {prompt} {skill}',
      timeoutMs: 30_000,
      cases: [{ id: 'x', prompt: 'p', checks: [{ id: 'c', describe: '', pattern: 'anything', expect: true }] }],
    }
    const report = await runEval(spec)
    assert.equal(report.results.length, 2)
    assert.ok(report.results.every((r) => r.exitCode === 3))
    assert.equal(report.skillScore, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the CLI honours its exit-code and rendering contracts', async () => {
  const { execFileSync } = await import('node:child_process')
  const run = (argv: string[]): { out: string; code: number } => {
    try {
      const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/index.ts', ...argv], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { out, code: 0 }
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string }
      return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 }
    }
  }

  // Help is success.
  assert.equal(run(['--help']).code, 0)
  assert.equal(run(['-h']).code, 0)
  // No command is a usage error.
  assert.equal(run([]).code, 1)
  // Unknown command is an error naming it.
  const unknown = run(['frobnicate'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.out, /Unknown command/)
  // --render on a non-report is rejected clearly, not with a raw crash.
  const badRender = run(['eval', 'package.json', '--render'])
  assert.equal(badRender.code, 1)
  assert.match(badRender.out, /not a skillsmith eval report/)

  // --failures prints the transcript of a failing skill-arm run. A percentage
  // says a check failed; only the text says whether the skill or the check is
  // at fault, and every real failure in this project's evals needed it.
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-test-'))
  try {
    const mk = (arm: 'baseline' | 'skill', passed: boolean, run_: number) => ({
      id: 'c',
      arm,
      run: run_,
      transcript: passed ? 'the good answer' : 'DISTINCTIVE-BAD-TEXT here',
      checks: [{ id: 'k', passed, matches: 0 }],
      exitCode: 0,
      tokens: null,
    })
    const report = {
      spec: { cases: [{ id: 'c', prompt: 'p', checks: [{ id: 'k', describe: '', pattern: 'x', expect: true }] }] },
      results: [mk('baseline', true, 1), mk('baseline', true, 2), mk('skill', false, 1), mk('skill', true, 2)],
      summary: [{ caseId: 'c', checkId: 'k', baseline: 1, skill: 0.5, delta: -0.5, baselineApplicable: 2, skillApplicable: 2 }],
      baselineScore: 1,
      skillScore: 0.5,
      significance: {
        significant: false,
        delta: -0.5,
        p: 1,
        baseline: { point: 1, low: 0.34, high: 1 },
        skill: { point: 0.5, low: 0.09, high: 0.91 },
        total: 2,
      },
      cost: { baselineMedian: null, skillMedian: null, delta: null },
      metrics: [],
    }
    const path = join(dir, 'report.json')
    await writeFile(path, JSON.stringify(report), 'utf8')

    const quiet = run(['eval', path, '--render'])
    assert.doesNotMatch(quiet.out, /DISTINCTIVE-BAD-TEXT/, 'transcripts stay hidden without the flag')

    const loud = run(['eval', path, '--render', '--failures'])
    assert.match(loud.out, /DISTINCTIVE-BAD-TEXT/, 'the failing run is shown')
    assert.match(loud.out, /failed: k/, 'and names the check it failed')
    assert.doesNotMatch(loud.out, /the good answer/, 'passing runs are not dumped')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the scaffold round-trips through the parser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-test-'))
  try {
    const raw = scaffoldSkill({ name: 'rt', summary: 'Round trip.', kind: 'mode' })
    await writeFile(join(dir, 'SKILL.md'), raw, 'utf8')
    const back = parseSkill(await readFile(join(dir, 'SKILL.md'), 'utf8'))
    assert.equal(back.frontmatter.name, 'rt')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
