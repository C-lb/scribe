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
    // A single delimiter is emphasis only when it hugs its content: no space
    // just inside, and for underscores a word boundary outside. Otherwise it
    // is arithmetic ("2 * 3") or an identifier ("resample_buffer"), and
    // eating it would silently corrupt the text.
    .replace(/\*(?!\s)([^*]+?)(?<!\s)\*/g, "$1")
    .replace(/(^|[\s(["'])_(?!\s)([^_]+?)(?<!\s)_(?=[\s).,;:!?\]"']|$)/g, "$1$2")
    .trim();
}

function fromRunning(summary) {
  const sections = [
    ["Topics", summary.topics ?? []],
    ["Key points", summary.keyPoints ?? []],
    [
      "Definitions",
      (summary.definitions ?? []).filter(
        ({ term, definition }) => term || definition
      ).map(
        ({ term, definition }) => term && definition ? `${term} — ${definition}` : (term || definition)
      ),
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
      const headingText = heading[1].replace(/\s+#+\s*$/, "");
      lines.push(stripInline(headingText));
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
    if (/^\s*(?:[-*_]){3,}\s*$/.test(raw)) continue;
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
