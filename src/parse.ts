/**
 * A SKILL.md is YAML frontmatter followed by markdown. We need just enough of
 * both to lint: the frontmatter keys, and the body split into headed sections.
 */

export interface Section {
  /** Heading text without the leading hashes. Empty for the preamble. */
  heading: string
  level: number
  body: string
  /** 1-based line the heading sits on, or 1 for the preamble. */
  line: number
}

export interface ParsedSkill {
  frontmatter: Record<string, string>
  /** Where the body begins, 1-based, for reporting line numbers. */
  bodyStartLine: number
  body: string
  sections: Section[]
  raw: string
}

export class ParseError extends Error {}

/**
 * Minimal YAML: `key: value` pairs and `key: >` / `key: |` folded blocks.
 * Frontmatter in the wild is almost never more than that, and taking a full
 * YAML dependency for it would be wrong for a zero-dependency tool.
 */
function parseFrontmatter(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!match) {
      i++
      continue
    }
    const key = match[1] as string
    let value = (match[2] ?? '').trim()

    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      // Block scalar: collect indented continuation lines.
      const collected: string[] = []
      i++
      while (i < lines.length && /^\s+\S/.test(lines[i] as string)) {
        collected.push((lines[i] as string).trim())
        i++
      }
      value = collected.join(value.startsWith('>') ? ' ' : '\n')
      out[key] = value
      continue
    }

    // Strip matching quotes.
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1)
    out[key] = value
    i++
  }
  return out
}

export function parseSkill(raw: string): ParsedSkill {
  const normalised = raw.replace(/\r\n/g, '\n')
  const lines = normalised.split('\n')

  if (lines[0]?.trim() !== '---') {
    throw new ParseError('SKILL.md must begin with a `---` frontmatter block on line 1')
  }
  const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---')
  if (end === -1) throw new ParseError('Frontmatter opened with `---` but never closed')

  const frontmatter = parseFrontmatter(lines.slice(1, end))
  const bodyLines = lines.slice(end + 1)
  const body = bodyLines.join('\n')

  const sections: Section[] = []
  let current: Section = { heading: '', level: 0, body: '', line: end + 2 }
  let inFence = false

  bodyLines.forEach((line, idx) => {
    if (/^\s*```/.test(line)) inFence = !inFence
    const h = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      sections.push(current)
      current = {
        heading: (h[2] as string).trim(),
        level: (h[1] as string).length,
        body: '',
        line: end + 2 + idx,
      }
      return
    }
    current.body += line + '\n'
  })
  sections.push(current)

  return { frontmatter, bodyStartLine: end + 2, body, sections, raw: normalised }
}
