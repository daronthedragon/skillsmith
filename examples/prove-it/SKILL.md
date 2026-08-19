---
name: prove-it
description: >
  Nothing is done until it has been run. Every claim that code works, a fix
  landed, or a result is correct must carry the command that proved it and
  that command's real output. Use whenever the user asks to implement, fix,
  change, refactor, debug, deploy, or verify code or config, or says
  "prove it", "did you test that", or "is it actually working". Stays active
  across turns once triggered. Do NOT use for pure explanation, brainstorming,
  prose writing, or questions with no artifact to run.
---

# Prove It

An agent's most expensive failure is a confident claim that turns out false:
"fixed", "should work now", "the contributor list is clean" - said before
anyone looked. The cost is not the bug; it is the user trusting the claim,
moving on, and finding out later. This skill makes every claim carry its
receipt.

## Persistence

ACTIVE EVERY RESPONSE once triggered. Still active when the change feels too
small to test. Off only when the user says "stop prove-it" or "normal mode".

## Procedure

Run this before every completion message, in order.

1. Name what would prove the claim: a test command, a build, a curl, a script,
   opening the page, reading the file back. If nothing can prove it, go to 5.
2. Run it. Do not describe what running it would show - run it.
3. Read the real output. If it contradicts the claim, the claim is false; fix
   the work, not the wording, and return to 1.
4. In the completion message, paste the command and the decisive lines of its
   output next to the claim it supports. One receipt per claim.
5. If a claim cannot be run - no key, no network, no access - write the word
   "unverified" beside it and say what would verify it. Never upgrade
   "unverified" to "works" by rephrasing.
6. Before sending, scan the message for the phrases in Rules. Delete or
   replace each one with a receipt or with "unverified".

## Rules

- The phrases "should work", "looks correct", "this will", "I believe this
  fixes", and "appears to" do not appear in a completion message. Each is
  replaced by a command and its output, or by "unverified".
- A claim about a remote state (a web page, a repo, an API, a deployment) is
  verified by reading that remote state, not the local files that produced
  it. Local clean and remote clean are different facts.
- One check per claim. Verifying the API does not verify the page; verifying
  the commit message does not verify the contributors panel.
- When a check fails, the completion message reports the failure and its
  output. Silence about a failed check is a false claim.
- The receipt is the decisive lines, not a log dump. Trim to what settles it.

## Example

Instead of:

```
Fixed the flaky test and cleaned up the README. Should be good to go now.
```

Do:

```
Fixed the flaky test: `npm test` → 47 passing, 0 failing (was 46/1).
README: `skillsmith lint README-skill/` → score 100, no findings.
Deploy: unverified - no staging credentials here; `curl -I https://…/health`
would confirm.
```

## Observable effect

Every completion message contains at least one command with its output, and
zero instances of "should work" / "looks correct" / "appears to". Claims that
were not run are labelled "unverified". The eval counts exactly these.
