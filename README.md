<div align="center">

# skillsmith

**Build agent skills that demonstrably change behaviour — and prove it.**

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-19%20passing-brightgreen)](#development)
[![Zero dependencies](https://img.shields.io/badge/runtime%20deps-0-blueviolet)](package.json)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)

</div>

---

Most agent skills are decoration. A paragraph of quality words the model already agrees with — *be helpful, write clean code, follow best practices* — loaded into context on every turn, changing nothing. Nobody notices, because nobody measures.

A skill that works is a **procedure** with a **trigger**, a **persistence rule**, and an **observable effect** someone can count in a transcript. skillsmith is three tools for building only that kind:

| | |
| :--- | :--- |
| **`lint`** | Checks a SKILL.md against the rules that decide whether it *can* work, and says why each one exists |
| **`new`** | Scaffolds a skill that passes lint on day one, with an eval spec beside it |
| **`eval`** | Runs prompts with and without the skill through your agent runner and reports the behaviour delta |

<p align="center">
  <img src="assets/lint-vibes.svg" width="720"
       alt="skillsmith lint scoring a vague adjectives-only skill 0 out of 100, listing three errors and six warnings with a concrete fix for each">
</p>

<sub>Real output. That is what "Helps you write better code. Be helpful, robust, follow best practices." scores.</sub>

<p align="center">
  <img src="assets/lint-prove-it.svg" width="720"
       alt="skillsmith lint scoring the prove-it skill 100 out of 100 with no findings">
</p>

<sub>And a skill built with the procedure below.</sub>

## Quick start

```bash
git clone https://github.com/daronthedragon/skillsmith.git
```

```bash
cd skillsmith && npm install && npm run build && npm link
```

```bash
skillsmith new prove-it --summary "Nothing is done until it has been run."
skillsmith lint prove-it
skillsmith eval prove-it/eval.json
```

Node 20+. No runtime dependencies.

## Why skills fail

Each lint rule names one way a skill ends up doing nothing. `skillsmith rules` prints them all; the ones that matter most:

- **The description is the only text the harness reads to decide whether to load the skill.** A vague one never fires — which is indistinguishable from the skill not working. It must say *when*, in terms of tasks and phrases, and it must say *when not*.
- **Models follow steps, not adjectives.** A skill with no numbered procedure is a mood, and moods do not survive past the first turn.
- **Every hedge is a permission slip.** "Try to", "where possible", "consider" — each one is the clause the model uses to skip the instruction under pressure. Hedged rules are optional rules.
- **A behavioural skill that does not say it persists gets forgotten** as the conversation grows. It has to state that it stays active, and name its off switch.
- **A skill with no stated observable effect cannot be evaluated**, so nobody will ever know whether it works. That is how most skills become decoration.

The linter quotes code blocks and quoted phrases out before scanning, so a skill can list the words it forbids without being flagged for using them.

## The eval

Lint tells you a skill *could* work. Only running it tells you it *does*.

`eval.json` pairs prompts with checks expressed as regexes over the transcript — things that should appear when the skill is active, things that should disappear. skillsmith runs every prompt twice, once with an empty skills directory and once with the skill staged, through whatever runner you configure, and reports pass rates for each arm:

```
  case / check                               without    with    delta
  ──────────────────────────────────────────────────────────────────
  fix-off-by-one / shows-a-command               33%    100%     +67%
  fix-off-by-one / no-should-work                 0%    100%    +100%
  unrunnable-claim / labels-unverified            0%     67%     +67%
  ──────────────────────────────────────────────────────────────────
  the skill changed behaviour: 11% → 89%
```

*Illustrative table showing the format. Run `skillsmith eval` against your own runner for real numbers — and see the honesty note below.*

**No model-as-judge.** A judge is another prompt whose behaviour you cannot verify, and the whole point here is verification. Checks are regexes you can read.

The runner is a command template: `{prompt}` is the shell-quoted prompt, `{skill}` a staged project directory whose `.claude/skills/` holds the skill (or nothing, for the baseline arm). Run the agent from inside it so project-level skill loading picks the skill up. For the Claude Code CLI:

```json
"runner": "cd {skill} && claude -p {prompt} --output-format text --dangerously-skip-permissions < /dev/null"
```

Any agent that can run one prompt headlessly and print the transcript will do.

## `examples/prove-it`

A complete skill built with skillsmith, included as the worked example: **nothing is done until it has been run.** Every completion claim carries the command that proved it and that command's real output; claims that cannot be run are labelled `unverified`. It lints 100/100 and ships with a three-case eval.

It exists because of a real afternoon: an agent declared a repo's contributor list clean three times — checking the API, then the commit message — before anyone looked at the actual page, where it was not.

## Use skillsmith as a skill

[`skill/SKILL.md`](skill/SKILL.md) is the skill that teaches an agent to build skills this way: name the observable effect first, scaffold instead of freehand, write the trigger as situations, lint and fix every error, fill the eval with real checks, run it, and report the delta. It lints 100/100 against its own rules.

```bash
mkdir -p ~/.claude/skills/skillsmith && cp skill/SKILL.md ~/.claude/skills/skillsmith/
```

## An honesty note

The eval harness is verified end to end by the test suite using a controlled runner that obeys the staged skill — it measures a 0% → 100% delta, proving the staging, the two arms, the scoring and the summary all work. It has **not** been run against a live model in this repository, because the machine it was built on had no headless agent CLI on PATH. The table above is therefore labelled illustrative. The first real eval you run is the real result, and skillsmith will print it whether or not it flatters the skill.

## Development

```bash
npm test
```

19 tests: frontmatter parsing (scalars, quoted, folded blocks, CRLF, fences that contain `#`), every lint rule against a skill that should pass and one that should fail, the one-shot exemption, that every finding carries a fix and every rule a reason, the scaffold passing its own linter, and the eval harness end to end — including that the skill is staged in one arm only, that a failing runner is scored rather than crashing, and a Windows-specific bug where POSIX quoting hung `cmd.exe`.

```bash
npm run typecheck
npm run build
```

## License

MIT
