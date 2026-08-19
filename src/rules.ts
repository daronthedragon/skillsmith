import type { ParsedSkill } from './parse.js'

export type Level = 'error' | 'warn' | 'info'

export interface Finding {
  rule: string
  level: Level
  message: string
  /** What to do about it. Every finding must be actionable. */
  fix: string
  line?: number
}

export interface Rule {
  id: string
  level: Level
  /** One sentence on why a skill missing this does not work. */
  why: string
  check: (skill: ParsedSkill) => Finding[]
}

const finding = (rule: Rule, message: string, fix: string, line?: number): Finding => ({
  rule: rule.id,
  level: rule.level,
  message,
  fix,
  line,
})

/**
 * The body with fenced code and quoted strings removed. Hedge and quality
 * word scans run on this, so a skill can *quote* the words it forbids - in a
 * bad example or a rule - without being flagged for using them.
 */
const prose = (text: string): string =>
  text
    // Both fence styles, so a ~~~ block hides its contents like a ``` one.
    .replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    // A quoted example rule can be long; the previous 80-char cap let a long
    // quoted "never say X" rule leak its own hedge words. Allow up to a
    // paragraph, still bounded so an unbalanced quote can't swallow the file.
    .replace(/"[^"]{1,400}"/g, (m) => (m.split('\n').length <= 3 ? ' ' : m))
    .replace(/“[^”]{1,400}”/g, (m) => (m.split('\n').length <= 3 ? ' ' : m))

/** Description plus body: the vague-language rules must cover the description,
 * the single most-read piece of a skill. */
const descriptionAndBody = (skill: ParsedSkill): string =>
  (skill.frontmatter.description ?? '') + '\n' + skill.body

/** Count lines matching a pattern, for "is there any of X" checks. */
const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length

/** Sentence-ish units in the description, for the trigger-coverage check. */
const TRIGGER_WORDS = /\b(use (this )?when|use (this )?for|use (this )?whenever|trigger|invoke when|whenever the user|when the user|when asked)/i
const NEGATIVE_SCOPE = /\b(do not use|don't use|not for|never use|do not trigger|skip (this )?(when|for)|not when)\b/i
const PERSISTENCE = /\b(every (response|turn|message|reply)|persist|stay(s)? active|remain(s)? active|until told|for the rest of)/i
const OFF_SWITCH = /\b(off only|turn(ed)? off|deactivate|disable|normal mode|to stop|to exit|says? "stop)\b|\bstop\b.{0,40}\b(mode|skill|this|it)\b/i
const HEDGE = /\b(try to|attempt to|consider|where possible|when appropriate|if possible|as needed|generally|ideally|should probably)\b/gi
const ADJECTIVE_SOUP = /\b(helpful|high[- ]quality|best practices|robust|clean|elegant|professional|excellent|great|good)\b/gi
const ORDERED_STEP = /^\s*\d+[.)]\s+\S/gm
const MEASURABLE = /\b(\d+(\.\d+)?\s?%|measure|median|benchmark|baseline|before\/after|before and after|scoreboard|count(s|ed)?\b)/i
const EXAMPLE_MARK = /(→|->|=>|\bfor example\b|\be\.g\.|\binstead of\b|\bnot\b.{0,30}\bbut\b)/i

export const RULES: Rule[] = [
  {
    id: 'frontmatter-name',
    level: 'error',
    why: 'Without a name the harness cannot register or invoke the skill at all.',
    check(skill) {
      const name = skill.frontmatter.name
      if (!name) return [finding(this, 'Missing `name` in frontmatter', 'Add `name: my-skill` (lowercase, hyphens).', 1)]
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        return [finding(this, `name "${name}" is not lowercase-hyphenated`, 'Use only a-z, 0-9 and hyphens, e.g. `prove-it`.', 1)]
      }
      return []
    },
  },

  {
    id: 'frontmatter-description',
    level: 'error',
    why: 'The description is the ONLY text the harness reads to decide whether to load the skill. A vague one means the skill never fires, which is indistinguishable from the skill not working.',
    check(skill) {
      const d = skill.frontmatter.description
      if (!d) return [finding(this, 'Missing `description` in frontmatter', 'Add a description that states when to use the skill.', 1)]
      const out: Finding[] = []
      if (d.length < 120) {
        out.push(finding(this, `description is ${d.length} chars; that is a label, not a trigger`, 'Describe the situations that should load it: tasks, user phrases, file types. Aim for 200-600 chars.', 1))
      }
      if (!TRIGGER_WORDS.test(d)) {
        out.push(finding(this, 'description never says WHEN to use the skill', 'Add explicit trigger conditions: "Use when the user asks to…", "Use whenever a task involves…".', 1))
      }
      return out
    },
  },

  {
    id: 'negative-scope',
    level: 'warn',
    why: 'A skill that fires on everything dilutes every other skill and burns context on tasks it does not help. The harness needs to know when NOT to load it.',
    check(skill) {
      // Scope belongs in the description, the only text the harness reads to
      // decide loading. An incidental "do not use tabs" in the body is not a
      // scope statement, so the body is no longer accepted as one.
      const d = skill.frontmatter.description ?? ''
      if (NEGATIVE_SCOPE.test(d)) return []
      return [finding(this, 'No statement of when NOT to use this skill', 'Add "Do NOT use for…" to the description, naming the nearby tasks it should stay out of.', 1)]
    },
  },

  {
    id: 'ordered-procedure',
    level: 'error',
    why: 'Models follow steps; they do not follow adjectives. A skill with no numbered procedure is a mood, and moods do not survive past the first turn.',
    check(skill) {
      const steps = count(prose(skill.body), ORDERED_STEP)
      if (steps >= 3) return []
      return [finding(this, `body has ${steps} numbered step(s); a working skill has an ordered procedure`, 'Write the behaviour as a numbered list the agent walks every time: "1. … 2. … 3. …". At least three steps, each a concrete action.')]
    },
  },

  {
    id: 'persistence',
    level: 'warn',
    why: 'A behavioural skill that does not say it stays active gets applied once and then forgotten as the conversation grows. Persistence has to be stated to survive.',
    check(skill) {
      // One-shot skills (generate a thing, run a check) do not need this.
      // Only an explicit "one-shot" marker exempts a skill. Matching "generate"
      // or "report" wrongly exempted persistent skills that merely mentioned them.
      const looksOneShot = /\bone[- ]shot\b/i.test(skill.frontmatter.description ?? '')
      if (looksOneShot) return []
      if (PERSISTENCE.test(skill.body)) return []
      return [finding(this, 'Behavioural skill has no persistence clause', 'State plainly: "ACTIVE EVERY RESPONSE until the user says stop." If this is a one-shot skill, say "one-shot" in the description.')]
    },
  },

  {
    id: 'off-switch',
    level: 'warn',
    why: 'If there is no stated way to turn it off, the user fights the skill instead of the task, and usually deletes it.',
    check(skill) {
      // Only an explicit "one-shot" marker exempts a skill. Matching "generate"
      // or "report" wrongly exempted persistent skills that merely mentioned them.
      const looksOneShot = /\bone[- ]shot\b/i.test(skill.frontmatter.description ?? '')
      if (looksOneShot) return []
      if (OFF_SWITCH.test(skill.body)) return []
      return [finding(this, 'No off switch', 'Name the phrase that disables it, e.g. "Off only when the user says \\"stop prove-it\\"."')]
    },
  },

  {
    id: 'no-hedging',
    level: 'warn',
    why: 'Every hedge ("try to", "where possible", "consider") is a permission slip the model will use to skip the instruction under pressure. Hedged rules are optional rules.',
    check(skill) {
      const hits = prose(descriptionAndBody(skill)).match(HEDGE) ?? []
      if (hits.length <= 2) return []
      const sample = [...new Set(hits.map((h) => h.toLowerCase()))].slice(0, 4).join('", "')
      return [finding(this, `${hits.length} hedges ("${sample}")`, 'Make each rule unconditional, or delete it. "Run the tests" beats "try to run the tests where possible".')]
    },
  },

  {
    id: 'no-adjective-soup',
    level: 'warn',
    why: 'Words like "helpful", "robust", "best practices" carry no instruction. The model already wants to be those things; repeating them changes nothing.',
    check(skill) {
      const hits = prose(descriptionAndBody(skill)).match(ADJECTIVE_SOUP) ?? []
      if (hits.length <= 3) return []
      const sample = [...new Set(hits.map((h) => h.toLowerCase()))].slice(0, 4).join('", "')
      return [finding(this, `${hits.length} content-free quality words ("${sample}")`, 'Replace each with the concrete behaviour you mean. "Robust" → "handle the empty-input case and say so".')]
    },
  },

  {
    id: 'concrete-example',
    level: 'warn',
    why: 'One before/after example does more than a page of rules: it shows the model the exact shape of the change you want.',
    check(skill) {
      if (EXAMPLE_MARK.test(skill.body) || /(```|~~~)/.test(skill.body)) return []
      return [finding(this, 'No concrete example of the behaviour', 'Add at least one "instead of X, do Y" pair, or a short fenced before/after block.')]
    },
  },

  {
    id: 'measurable',
    level: 'info',
    why: 'A skill with no stated observable effect cannot be evaluated, so nobody will ever know whether it works. That is how most skills end up as decoration.',
    check(skill) {
      if (MEASURABLE.test(prose(skill.body))) return []
      return [finding(this, 'Nothing in the skill says what observable change it produces', 'Add one line naming the measurable effect: fewer tool calls, shorter replies, tests run before "done", etc. The eval harness checks for exactly this.')]
    },
  },

  {
    id: 'length',
    level: 'warn',
    why: 'Every line of a skill is loaded into context on every turn it is active. Past a few hundred lines the cost exceeds the benefit, and the important rules drown.',
    check(skill) {
      const lines = skill.body.split('\n').length
      if (lines <= 250) return []
      return [finding(this, `body is ${lines} lines`, 'Cut to the rules that change behaviour. Move reference material into a separate file the skill points at.')]
    },
  },

  {
    id: 'no-self-reference',
    level: 'info',
    why: 'Skills that narrate themselves ("this skill helps you…") spend words on the reader instead of on the agent. The agent is the reader.',
    check(skill) {
      const hits = count(prose(skill.body), /\bthis skill (helps|allows|enables|provides|is designed)/gi)
      if (hits === 0) return []
      return [finding(this, `${hits} line(s) describing the skill to a human instead of instructing the agent`, 'Write in the imperative, to the agent: "Do X. Never Y."')]
    },
  },
]

export interface LintResult {
  findings: Finding[]
  errors: number
  warnings: number
  /** 0-100. Errors cost 25, warnings 8, info 3. Floors at 0. */
  score: number
}

export function lint(skill: ParsedSkill): LintResult {
  const findings = RULES.flatMap((rule) => rule.check(skill))
  const errors = findings.filter((f) => f.level === 'error').length
  const warnings = findings.filter((f) => f.level === 'warn').length
  const infos = findings.filter((f) => f.level === 'info').length
  const score = Math.max(0, 100 - errors * 25 - warnings * 8 - infos * 3)
  return { findings, errors, warnings, score }
}
