/**
 * One conversion feeds Copy, Save, and Share. Two inputs, one output: a
 * running summary is structured data, a final summary is Claude's Markdown,
 * and both end as text a person can paste into a chat window.
 */

function collapseBlankRuns(lines) {
  const out = [];
  for (const line of lines) {
    if (line === "" && out[out.length - 1] === "") continue;
    out.push(line);
  }
  return out;
}

/** Emphasis and code markers only. Structure is handled before this runs. */
function stripInline(text) {
  return text
    .replace(/`+/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .trim();
}

function fromRunning(summary) {
  const sections = [
    ["Topics", summary.topics ?? []],
    ["Key points", summary.keyPoints ?? []],
    [
      "Definitions",
      (summary.definitions ?? []).map(({ term, definition }) => `${term} — ${definition}`),
    ],
    ["Flagged", summary.flagged ?? []],
    ["Open questions", summary.openQuestions ?? []],
  ];

  const blocks = [];
  for (const [title, items] of sections) {
    if (!items.length) continue;
    blocks.push([title, ...items.map((item) => `• ${item}`)].join("\n"));
  }
  return blocks.join("\n\n");
}

function fromMarkdown(markdown) {
  const lines = [];
  for (const raw of String(markdown).split("\n")) {
    // Structure first, emphasis second: stripping `*` first would eat the
    // bullet marker at the start of a line.
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      lines.push(stripInline(heading[1]));
      continue;
    }

    const bullet = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (bullet) {
      const depth = Math.floor(bullet[1].length / 2);
      const marker = depth === 0 ? "•" : "◦";
      lines.push(`${"  ".repeat(depth)}${marker} ${stripInline(bullet[2])}`);
      continue;
    }

    if (/^\s*(```|~~~)/.test(raw)) continue;
    lines.push(stripInline(raw));
  }
  return collapseBlankRuns(lines).join("\n").trim();
}

export function summaryToPlainText(input) {
  if (!input) return "";
  if (input.kind === "running") return fromRunning(input.summary ?? {});
  if (input.kind === "markdown") return fromMarkdown(input.markdown ?? "");
  return "";
}

export function sanitiseFilename(title, fallbackId) {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallbackId;
}
