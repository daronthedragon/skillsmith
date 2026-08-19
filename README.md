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
| **`eval`** | Runs prompts with and without the skill through your agent runner, then reports the delta with a significance test, a confidence interval, and the token cost — so a real change is told apart from noise |

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

`eval.json` pairs prompts with checks expressed as regexes over the transcript — things that should appear when the skill is active, things that should disappear. skillsmith runs every prompt twice, once with an empty skills directory and once with the skill staged, through whatever runner you configure, and reports pass rates for each arm.

Here is a real run of the **harder eval** ([`eval-hard.json`](examples/prove-it/eval-hard.json)) against `claude -p` (Claude Code 2.1.235), **5 repeats** per case, all 40 runs exited 0. The full report is committed at [`examples/prove-it/eval-hard-report.json`](examples/prove-it/eval-hard-report.json).

<p align="center">
  <img src="assets/eval-hard.svg" width="700"
       alt="skillsmith eval with significance testing: pooled delta -8 percent, p=0.45, not significant. The +33 percent seen at three repeats did not survive five repeats.">
</p>

**This is the result that matters most, and it is not the flattering one.** An earlier run of this eval at *three* repeats showed `computed-value` jump from 67% to 100% — a +33% win, which this README reported. Re-run at *five* repeats, that same delta went to **−20%**, and the pooled two-proportion test across all 40 runs returns **−8%, p=0.45: not significant.** The +33% was noise, and skillsmith's own significance test — added after the fact — caught its author's published overclaim.

That is the tool doing exactly its job. The per-check picture at n=5:

- **`computed-value`: 80% → 60%.** The behaviour the +33% was built on does not reproduce. At three runs it looked like the skill forced a run; at five, the base model runs the code about as often either way, and the difference is within noise.
- **`trivial-correctness`: 0% → 0%.** Neither arm runs a trivially-correct list comprehension. prove-it does not force a run on something the model is certain about.
- **`stale-remote-state`, `partial-pipeline`: 100% → 100%.** The base model already refuses to assert stale remote state and already qualifies an un-run deploy step. Nothing to add.

**Honest conclusion: on this model, this eval does not show prove-it changing behaviour.** The cost line explains why that is at least cheap — the skill adds ~0 tokens per run — but cheap and inert is still inert. A skill is worth shipping when an eval that *can* fail shows a *significant* pass; this one does not, and the tool says so in red. The lesson is the one the significance test exists to enforce: **a positive delta on a tiny sample is not evidence.** Three runs suggested a win; five dissolved it.

Four mechanics make the eval a measurement rather than a demo:

- **Significance, not just a delta.** Every pass rate carries a 95% Wilson interval, and the two arms are compared with a pooled two-proportion test. The exit code is success only when the improvement is *significant*, not merely positive — which is why the run above exits non-zero. The `computed-value` reversal is the whole argument for this: a delta you cannot distinguish from noise is not a result, and before this was added the eval happily reported one.
- **Cost accounting.** Median tokens per run for each arm, and what the skill adds. A skill that helps but costs 3,000 tokens a turn is a different decision from one that is free; the report makes that visible. prove-it costs ~0, which is the only good news in the run above.
- **A stream-json runner**, so the transcript contains the actual `tool_use` and `tool_result` events. Under `--output-format text` a tool run is invisible — a model that recites a value from memory looks identical to one that ran it. The stream format makes "did it actually run" directly observable.
- **Implication guards** (`given` on a check): *when* the agent claims success, a real run must be present. A transcript that never makes the claim passes vacuously — being cautious is not a failure. This is what fixes keyword-matching: an earlier check read 0% because the model said *"No — not from here"* instead of the prescribed word "unverified", which is the right behaviour phrased differently.

Runs are isolated (each gets its own working directory, so one run's files never leak into the next) and executed with bounded concurrency (`concurrency`, default 4), so a 40-run eval finishes in minutes rather than the better part of an hour.

### The first eval, and why it taught nothing

The first eval ([`eval.json`](examples/prove-it/eval.json), [report](examples/prove-it/eval-report.json)) scored **86% → 81%** — no improvement — because its tasks were ones the base model already passed and its checks matched vocabulary. It is kept in the repo, not deleted, as the first of three honest negatives: an eval too easy to fail, an eval that faked a pass at small n, and — once significance was enforced — the plain finding that this skill does not measurably change this model's behaviour. That progression is the point.

**No model-as-judge.** A judge is another prompt whose behaviour you cannot verify, and the whole point here is verification. Checks are regexes you can read.

The runner is a command template: `{prompt}` is the shell-quoted prompt, `{skill}` a staged project directory whose `.claude/skills/` holds the skill (or nothing, for the baseline arm). Run the agent from inside it so project-level skill loading picks the skill up. For the Claude Code CLI:

```json
"runner": "cd {skill} && claude -p {prompt} --output-format stream-json --verbose --dangerously-skip-permissions --no-session-persistence"
```

`stream-json` is what puts the tool calls in the transcript; `text` gives only the final message, which hides whether the agent actually ran anything. Any agent that can run one prompt headlessly and print a transcript with its tool activity will do.

## `examples/prove-it`

A complete skill built with skillsmith, included as the worked example: **nothing is done until it has been run.** Every completion claim carries the command that proved it and that command's real output; claims that cannot be run are labelled `unverified`. It lints 100/100 and ships with a three-case eval.

It exists because of a real afternoon: an agent declared a repo's contributor list clean three times — checking the API, then the commit message — before anyone looked at the actual page, where it was not.

## Use skillsmith as a skill

[`skill/SKILL.md`](skill/SKILL.md) is the skill that teaches an agent to build skills this way: name the observable effect first, scaffold instead of freehand, write the trigger as situations, lint and fix every error, fill the eval with real checks, run it, and report the delta. It lints 100/100 against its own rules.

```bash
mkdir -p ~/.claude/skills/skillsmith && cp skill/SKILL.md ~/.claude/skills/skillsmith/
```

## What this project is honest about

Both evals are real runs, kept in the repo whether or not they flatter the skill. The first showed no benefit. The second, at three repeats, showed a +33% that this README reported as a win — and then the significance test built into skillsmith, run at five repeats, showed that +33% was noise. That reversal is left in the README on purpose: a tool for measuring whether skills work has to be willing to say its author's own headline was wrong, and this one did.

Two lessons the first measurement forced, both now built into the harder eval: an eval whose baseline already scores near the ceiling cannot show a skill's value, so the tasks have to tempt the base model into the failure; and a check that matches a required *word* instead of the *behaviour* reads a correct answer as a failure, so checks use implication guards and a transcript that contains the real tool calls.

The harness itself is also covered by the test suite with a controlled runner, which measures a clean 0% → 100% delta — proving the staging, the two arms, the scoring and the summary work independently of any model.

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
