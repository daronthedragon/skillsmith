---
name: skillsmith
description: >
  Build, lint, and evaluate agent skills that demonstrably change behaviour,
  instead of writing adjectives that change nothing. Use whenever the user asks
  to create a skill, write a SKILL.md, improve or fix an existing skill, make a
  skill "actually work", or evaluate whether a skill does anything. Also use
  when the user says "skillsmith", "new skill", or "lint this skill". Stays
  active for the rest of the skill-building task. Do NOT use for writing
  ordinary prompts, system prompts for products, or documentation that is not
  a skill.
---

# Skillsmith

Most skills are decoration: a paragraph of quality words the model already
agrees with, loaded into context on every turn, changing nothing. A skill that
works is a **procedure** with a **trigger**, a **persistence rule**, and an
**observable effect** someone can measure. Build only that kind.

## Persistence

ACTIVE EVERY RESPONSE for the duration of a skill-building task. Still active
when unsure whether the current edit counts. Off only when the user says
"stop skillsmith" or the skill task is finished and linted.

## Procedure

Run this every time a skill is created or changed, in order.

1. **Name the observable effect first.** Before writing a line, state in one
   sentence what will be different in a transcript when the skill is active:
   fewer tool calls, a test command before every "done", replies under N
   lines. If you cannot name it, the skill has no purpose yet. Stop and ask.
2. **Scaffold, never freehand.** Run `skillsmith new <name> --summary "..."`
   (add `--oneshot` for a run-once skill). It produces a SKILL.md and an
   `eval.json` that pass lint by construction. Edit those; do not start from a
   blank file.
3. **Write the trigger as situations, not a label.** The `description` is the
   only text the harness reads to decide whether to load the skill. It must
   say *when*: tasks, user phrases, file types. It must also say when NOT,
   naming the nearby tasks the skill should stay out of.
4. **Write the behaviour as numbered steps.** Each step is a verb and an
   object, checkable from a transcript. Conditions name both branches. No
   step may be "be careful", "consider", or "try to".
5. **Add one before/after example.** Instead-of / do. A real excerpt, not a
   description of one.
6. **Lint, and fix every error.** `skillsmith lint <dir>`. Errors mean the
   skill cannot work; warnings mean it will drift. Do not ship with errors.
   Do not argue with a warning in the summary - fix it or delete the rule it
   complains about.
7. **Fill the eval with real checks.** In `eval.json`, set `runner` to the
   command that runs one prompt, write two or more prompts where the skill
   should change behaviour, and express each expected change as a regex the
   transcript will or will not contain. Never use a model as the judge.
8. **Run the eval and report the delta.** `skillsmith eval <dir>/eval.json`.
   A skill with no measurable delta is not done; it is decoration. Report
   the without → with numbers verbatim in your summary.

## Rules

- Write to the agent, in the imperative. Never "this skill helps you".
- One unconditional rule beats three hedged ones. Delete every "where
  possible", "try to", "consider", "as needed".
- Quality words are not instructions. Replace "robust", "clean", "helpful",
  "best practices" with the concrete behaviour meant.
- A behavioural skill states that it persists and names its off switch. A
  one-shot skill says "one-shot" in its description and skips both.
- Keep the body under 250 lines. Reference material goes in a separate file
  the skill points at, not in the skill.
- Never claim a skill works until the eval shows a delta. "Lints clean" is
  not "works".

## Example

Instead of:

```
---
name: careful
description: Helps the agent be more careful and write better code.
---
Be careful. Consider edge cases. Follow best practices and try to test
where possible.
```

Do:

```
---
name: prove-it
description: >
  Nothing is done until it has been run. Use whenever the user asks to
  implement, fix, or change code. Stays active across turns. Do NOT use
  for explanation or prose tasks.
---
## Procedure
1. Before writing "done", run the command that exercises the change.
2. Paste the command and its output in the completion message.
3. If it cannot be run, write "unverified" and say why.
## Observable effect
Every completion message contains a command and its output; the phrase
"should work" does not appear.
```

## Observable effect

When skillsmith is active, every new or edited skill ends the task with a lint
score and an eval delta (without → with) in the summary. No skill is called
"done" or "working" without both numbers.
