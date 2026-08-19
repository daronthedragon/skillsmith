import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPersistText } from './persist.js'
import {
  generateHookScript,
  installHook,
  mergeHook,
  removeHook,
  unmergeHook,
} from './hook.js'

const SKILL = `---
name: prove-it
description: >
  Nothing is done until it has been run. Use whenever the user asks to change
  code. Stays active across turns. Do NOT use for prose.
---

# Prove It

## Persistence

ACTIVE EVERY RESPONSE. Off only when the user says "stop prove-it".

## Procedure

1. Run the command that exercises the change.
2. Paste it and its output.
3. If it cannot be run, write "unverified".

## Rules

- Never write "should work".
- Every claim carries its command.
- Verify remote state by reading it, not the files that produced it.

## Observable effect

Every completion message contains a command and its output; "should work" never appears.
`

// ------------------------------------------------------------- buildPersistText

test('buildPersistText pulls the name, rules and effect into a compact block', () => {
  const out = buildPersistText(SKILL)
  assert.match(out, /^<skill:prove-it>/)
  assert.match(out, /prove-it is active this turn/)
  assert.match(out, /- Never write "should work"\./)
  assert.match(out, /- Every claim carries its command\./)
  assert.match(out, /Done means: Every completion message contains a command/)
  assert.match(out, /<\/skill:prove-it>\n$/)
  // Compact: it must not drag the whole file in.
  assert.ok(!out.includes('## Procedure'), 'procedure should not be injected every turn')
  assert.ok(out.split('\n').length < 12)
})

test('buildPersistText never emits an empty reminder when Rules is missing', () => {
  const out = buildPersistText('---\nname: x\n---\n# X\nNo rules here.\n')
  assert.match(out, /<skill:x>/)
  assert.match(out, /- Follow the skill/)
})

test('buildPersistText tolerates CRLF', () => {
  const out = buildPersistText(SKILL.replace(/\n/g, '\r\n'))
  assert.match(out, /- Never write "should work"\./)
})

test('buildPersistText matches headings case-insensitively', () => {
  const lower = '---\nname: x\n---\n## rules\n\n- Alpha rule.\n\n## observable effect\n\nThe effect.\n'
  const out = buildPersistText(lower)
  assert.match(out, /- Alpha rule\./, 'lowercase ## rules must still be found')
  assert.match(out, /Done means: The effect\./)
})

test('buildPersistText skips a fenced block between bullets instead of gluing it on', () => {
  const withFence =
    '---\nname: x\n---\n## Rules\n\n- Real rule.\n```\n- fake bullet in a fence\n```\n- Second rule.\n'
  const out = buildPersistText(withFence)
  assert.match(out, /- Real rule\./)
  assert.match(out, /- Second rule\./)
  assert.ok(!out.includes('fake bullet'), 'fenced content must not become part of a rule')
})

test('a path with an apostrophe produces a runnable script, not a SyntaxError', async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillsmith-O'Brien-"))
  try {
    const skillMd = join(dir, 'SKILL.md')
    await writeFile(skillMd, SKILL, 'utf8')
    const scriptPath = join(dir, 'persist.mjs')
    await writeFile(scriptPath, generateHookScript(skillMd), 'utf8')
    // Must not throw a SyntaxError; must emit the reminder.
    const printed = execFileSync('node', [scriptPath], { encoding: 'utf8' })
    assert.match(printed, /is active this turn/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeHook refuses a non-object hooks value instead of silently writing nothing', () => {
  assert.throws(() => mergeHook({ hooks: [] as unknown as Record<string, never> }, '/x/persist.mjs'), /not an object/)
  assert.throws(
    () => mergeHook({ hooks: { UserPromptSubmit: 'nope' as unknown as [] } }, '/x/persist.mjs'),
    /not an array/,
  )
})

// ------------------------------------------------------------- generated script

test('the generated hook script produces exactly what buildPersistText does', async () => {
  // The standalone script inlines the extractor; this is the anti-drift guard.
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-hook-'))
  try {
    const skillMd = join(dir, 'SKILL.md')
    await writeFile(skillMd, SKILL, 'utf8')
    const scriptPath = join(dir, 'persist.mjs')
    await writeFile(scriptPath, generateHookScript(skillMd), 'utf8')

    const printed = execFileSync('node', [scriptPath], { encoding: 'utf8' })
    assert.equal(printed, buildPersistText(SKILL))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the generated script stays silent if the skill file is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-hook-'))
  try {
    const scriptPath = join(dir, 'persist.mjs')
    await writeFile(scriptPath, generateHookScript(join(dir, 'missing.md')), 'utf8')
    const printed = execFileSync('node', [scriptPath], { encoding: 'utf8' })
    assert.equal(printed, '', 'a persistence reminder must never block a prompt')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// -------------------------------------------------------------------- merging

test('mergeHook adds a UserPromptSubmit entry and is idempotent', () => {
  const settings = {}
  const first = mergeHook(settings, '/x/persist.mjs')
  assert.equal(first.added, true)
  assert.equal(first.settings.hooks?.UserPromptSubmit?.length, 1)

  const second = mergeHook(first.settings, '/x/persist.mjs')
  assert.equal(second.added, false, 're-install must not duplicate')
  assert.equal(second.settings.hooks?.UserPromptSubmit?.length, 1)
})

test('mergeHook preserves unrelated settings and existing hooks', () => {
  const settings = {
    includeCoAuthoredBy: false,
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command' as const, command: 'echo hi' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command' as const, command: 'other-tool' }] }],
    },
  }
  const { settings: after } = mergeHook(settings, '/x/persist.mjs')
  assert.equal(after.includeCoAuthoredBy, false, 'unrelated keys untouched')
  assert.equal((after.hooks?.SessionStart as unknown[] | undefined)?.length, 1, 'other events untouched')
  assert.equal(after.hooks?.UserPromptSubmit?.length, 2, 'existing UserPromptSubmit entry kept')
  const commands = after.hooks!.UserPromptSubmit!.flatMap((e) => e.hooks.map((h) => h.command))
  assert.ok(commands.includes('other-tool'))
})

test('unmergeHook removes only our entry and drops empty groups', () => {
  const { settings } = mergeHook(
    { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command' as const, command: 'other-tool' }] }] } },
    '/x/persist.mjs',
  )
  const { removed, settings: after } = unmergeHook(settings, '/x/persist.mjs')
  assert.equal(removed, true)
  const commands = after.hooks!.UserPromptSubmit!.flatMap((e) => e.hooks.map((h) => h.command))
  assert.deepEqual(commands, ['other-tool'], 'other tool survives, ours is gone')
})

// -------------------------------------------------------------- install round trip

test('installHook writes the runtime and wires settings, removeHook reverses it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-hook-'))
  try {
    const skillDir = join(dir, 'prove-it')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), SKILL, 'utf8')
    const settingsPath = join(dir, 'settings.json')
    await writeFile(settingsPath, JSON.stringify({ includeCoAuthoredBy: false }), 'utf8')

    const r = await installHook({ skillDir, settingsPath })
    assert.equal(r.added, true)

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    assert.equal(settings.includeCoAuthoredBy, false, 'existing settings preserved')
    assert.equal(settings.hooks.UserPromptSubmit.length, 1)
    assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /persist\.mjs/)

    // The written runtime actually runs and injects the core.
    const printed = execFileSync('node', [r.scriptPath], { encoding: 'utf8' })
    assert.match(printed, /prove-it is active this turn/)

    const back = await removeHook({ skillDir, settingsPath })
    assert.equal(back.removed, true)
    const cleaned = JSON.parse(await readFile(settingsPath, 'utf8'))
    assert.equal(cleaned.hooks.UserPromptSubmit.length, 0)
    assert.equal(cleaned.includeCoAuthoredBy, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('installHook accepts a BOM-prefixed settings.json (PowerShell default)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-hook-'))
  try {
    const skillDir = join(dir, 'prove-it')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), SKILL, 'utf8')
    const settingsPath = join(dir, 'settings.json')
    await writeFile(settingsPath, '﻿' + JSON.stringify({ theme: 'dark' }), 'utf8')

    const r = await installHook({ skillDir, settingsPath })
    assert.equal(r.added, true)
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    assert.equal(settings.theme, 'dark')
    assert.equal(settings.hooks.UserPromptSubmit.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a bad settings.json aborts install before any persist.mjs is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-hook-'))
  try {
    const skillDir = join(dir, 'prove-it')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), SKILL, 'utf8')
    const settingsPath = join(dir, 'settings.json')
    await writeFile(settingsPath, '{ this is not json', 'utf8')

    await assert.rejects(() => installHook({ skillDir, settingsPath }), /not valid JSON/)
    // No stray runtime script left behind.
    const { access } = await import('node:fs/promises')
    await assert.rejects(() => access(join(skillDir, 'persist.mjs')), 'persist.mjs must not exist after a failed install')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
