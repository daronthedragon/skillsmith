import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEval, scoreTranscript, type EvalSpec } from './eval.js'
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
