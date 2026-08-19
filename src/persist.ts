/**
 * The compact reminder a persistence hook injects on every turn.
 *
 * A SKILL.md is loaded once and drifts out of attention as the conversation
 * grows; that is the whole reason the linter demands a persistence clause. A
 * UserPromptSubmit hook fixes it for real by re-asserting the skill's
 * enforceable core each turn — but re-injecting the whole file every prompt is
 * wasteful, so this pulls out only the parts that must stay true: the name, the
 * rules, and the one-line observable effect.
 *
 * The implementation lives as a plain-JS source string so the installer can
 * embed the identical logic in a standalone hook script. There is one source of
 * truth: the runtime function below is built from it, and the generated script
 * inlines it verbatim, so the two can never drift. (Deriving the script from
 * `.toString()` instead breaks, because a transpiler rewrites the function body
 * with helper calls that are undefined in plain node.)
 */
export const PERSIST_SOURCE = `function buildPersistText(raw) {
  const text = raw.replace(/\\r\\n/g, "\\n");
  const nameMatch = /^name:\\s*(.+)$/m.exec(text);
  const name = nameMatch ? nameMatch[1].trim() : "this skill";

  const section = (heading) => {
    const start = heading.exec(text);
    if (!start) return "";
    const rest = text.slice(start.index + start[0].length);
    const next = /^#{1,6}\\s+/m.exec(rest);
    return (next ? rest.slice(0, next.index) : rest).trim();
  };

  const isFence = (line) => line.indexOf("\`\`\`") === 0 || line.indexOf("~~~") === 0;

  // Reassemble bullets: a rule may wrap across several physical lines, and a
  // reminder truncated mid-sentence is worse than none. Fenced code between a
  // bullet and the next is skipped, not glued onto the rule. Headings are
  // matched case-insensitively so "## rules" is not silently missed.
  const rules = [];
  let inFence = false;
  for (const rawLine of section(/^#{1,6}\\s+Rules\\s*$/im).split("\\n")) {
    const line = rawLine.trim();
    if (isFence(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (line.indexOf("- ") === 0) {
      rules.push(line.slice(2).trim());
    } else if (line.length > 0 && rules.length > 0) {
      rules[rules.length - 1] += " " + line;
    }
  }

  // The effect's first paragraph, joined across its wrapped lines.
  const effectLines = [];
  for (const rawLine of section(/^#{1,6}\\s+Observable effect\\b.*$/im).split("\\n")) {
    const line = rawLine.trim();
    if (isFence(line)) break;
    if (line.length === 0) {
      if (effectLines.length > 0) break;
    } else {
      effectLines.push(line);
    }
  }
  const effect = effectLines.join(" ");

  const lines = ["<skill:" + name + ">", name + " is active this turn. Hold to it before you finish:"];
  if (rules.length > 0) {
    for (const r of rules) lines.push("- " + r);
  } else {
    lines.push("- Follow the skill you were given; do not drift back to default behaviour.");
  }
  if (effect) lines.push("Done means: " + effect);
  lines.push("</skill:" + name + ">");
  return lines.join("\\n") + "\\n";
}`

/** Materialised from the single source above, so it can never diverge from it. */
export const buildPersistText: (raw: string) => string = new Function(
  `${PERSIST_SOURCE}; return buildPersistText;`,
)() as (raw: string) => string
