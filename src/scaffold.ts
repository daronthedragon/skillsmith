/**
 * Generate a SKILL.md that passes every lint rule on day one, with the slots a
 * working skill needs already in place. Placeholders are loud on purpose so
 * they cannot ship by accident.
 */

export interface ScaffoldOptions {
  name: string
  /** One line: what the skill does to the agent's behaviour. */
  summary: string
  /** 'mode' stays active across turns; 'oneshot' runs once and ends. */
  kind: 'mode' | 'oneshot'
}

const upper = (s: string) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export function scaffoldSkill(opts: ScaffoldOptions): string {
  const { name, summary, kind } = opts
  const title = upper(name)

  const description =
    kind === 'mode'
      ? `${summary} Use whenever the user is doing [TASK TYPE], asks for [PHRASE], or says "${name}". Stays active across turns once triggered. Do NOT use for [NEARBY TASK IT SHOULD STAY OUT OF].`
      : `${summary} One-shot: use when the user asks to [TRIGGER], or says "${name}". Produces a [ARTIFACT] and ends. Do NOT use for [NEARBY TASK IT SHOULD STAY OUT OF].`

  const persistence =
    kind === 'mode'
      ? `## Persistence

ACTIVE EVERY RESPONSE once triggered. Still active if unsure. Off only when
the user says "stop ${name}" or "normal mode".
`
      : ''

  return `---
name: ${name}
description: >
  ${description}
---

# ${title}

${summary}

${persistence}## Procedure

Run this every time, in order. Stop at the first step that resolves the task.

1. [FIRST CONCRETE ACTION. A verb and an object. "Grep for the symbol before opening any file."]
2. [SECOND. Each step must be checkable from the transcript.]
3. [THIRD. If a step has a condition, state the condition and both branches.]
4. [LAST. What to do when none of the above applied.]

## Rules

- [One unconditional rule. No "try to", no "where possible". "Do X." or "Never Y."]
- [A second. Each rule names a behaviour, not a quality. "Run the tests" not "be careful".]
- [A third, if needed. Three to six is the range; more and they stop being read.]

## Example

Instead of:

\`\`\`
[WHAT THE AGENT DOES WITHOUT THIS SKILL - a realistic short transcript excerpt]
\`\`\`

Do:

\`\`\`
[WHAT IT DOES WITH THE SKILL - same situation, changed behaviour]
\`\`\`

## Observable effect

When this skill is working, the transcript shows: [MEASURABLE CHANGE - fewer
tool calls, a test command before every "done", replies under N lines, etc.].
This is what the eval checks for.
`
}

/** A starter eval spec next to the skill, with one real check per slot. */
export function scaffoldEval(name: string, skillPath: string): string {
  return JSON.stringify(
    {
      skill: skillPath,
      runner: 'REPLACE: command that runs one prompt from inside {skill} and prints the transcript, e.g. cd {skill} && claude -p {prompt} --output-format text',
      repeat: 2,
      timeoutMs: 180000,
      cases: [
        {
          id: 'example-case',
          prompt: `REPLACE: a realistic task where ${name} should change what the agent does`,
          checks: [
            {
              id: 'shows-desired-behaviour',
              describe: 'REPLACE: the thing the skill should make appear',
              pattern: 'REPLACE-regex',
              expect: true,
            },
            {
              id: 'drops-undesired-behaviour',
              describe: 'REPLACE: the thing the skill should make go away',
              pattern: 'REPLACE-regex',
              expect: false,
            },
          ],
        },
      ],
    },
    null,
    2,
  )
}
