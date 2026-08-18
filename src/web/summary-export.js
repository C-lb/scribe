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

/**
 * No dead buttons: either the control works, or it says why it does not —
 * except at page load, before any recording has started, where the summary
 * pane's own placeholder already says the first summary takes about five
 * minutes. Repeating that is fine; inventing a failure that never happened
 * is not, so the reason stays empty until a session actually exists.
 */
export function exportState({ input, recording, started }) {
  if (input) return { enabled: true, reason: "" };
  if (recording) {
    return { enabled: false, reason: "The first summary appears after about five minutes." };
  }
  if (!started) return { enabled: false, reason: "" };
  return {
    enabled: false,
    reason: "The summary for this session failed, so there is nothing to send.",
  };
}

export function buildMarkdownFile({ title, sessionId, markdown }) {
  const body = String(markdown ?? "");
  const heading = `# ${title}`;
  // Only skip prepending when the markdown already opens with an H1 of its
  // own ("# ") — an H2 or deeper still needs the document-level title above it.
  const text = /^#(?!#)\s/.test(body.trimStart()) ? body : `${heading}\n\n${body}`;
  return { name: `${sanitiseFilename(title, sessionId)}.md`, text };
}

/**
 * Copy, Save, and Share. Share only exists where the browser has the API:
 * a button that fails when pressed is worse than one that was never there.
 */
export function createExportControls({ root, getSummary, setStatus }) {
  const copyButton = root.querySelector("#summary-copy");
  const saveButton = root.querySelector("#summary-save");
  const shareButton = root.querySelector("#summary-share");
  const summaryEl = document.getElementById("summary");
  // A tooltip on a disabled button is invisible to keyboard and screen-reader
  // users: a disabled control drops out of the tab order, so it never gets
  // focus, so the title never shows. "No dead buttons" means the reason has
  // to be visible text too, not just a hover hint.
  const reasonEl = document.getElementById("summary-actions-reason");

  shareButton.hidden = typeof navigator.share !== "function";

  function refresh() {
    const { input, recording } = getSummary();
    const { enabled, reason } = exportState({ input, recording });
    for (const button of [copyButton, saveButton, shareButton]) {
      button.disabled = !enabled;
      button.title = reason;
    }
    reasonEl.textContent = reason;
    reasonEl.hidden = enabled;
  }

  copyButton.addEventListener("click", async () => {
    const { input } = getSummary();
    const text = summaryToPlainText(input);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Summary copied");
    } catch (error) {
      // Failing to a state the user can rescue beats failing to a message.
      console.error("[scribe] clipboard write refused", error);
      const range = document.createRange();
      range.selectNodeContents(summaryEl);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      setStatus("Could not reach the clipboard. The summary is selected, press Cmd-C");
    }
  });

  saveButton.addEventListener("click", () => {
    const { input, title, sessionId } = getSummary();
    const markdown =
      input.kind === "markdown" ? input.markdown : summaryToPlainText(input);
    const file = buildMarkdownFile({ title, sessionId, markdown });

    const url = URL.createObjectURL(new Blob([file.text], { type: "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(`Saved ${file.name}`);
  });

  shareButton.addEventListener("click", async () => {
    const { input, title, sessionId } = getSummary();
    const text = summaryToPlainText(input);
    const markdown = input.kind === "markdown" ? input.markdown : text;
    const built = buildMarkdownFile({ title, sessionId, markdown });

    // Built before the call and shared without an intervening await: the API
    // requires a user gesture and rejects once the gesture has been spent.
    const file = new File([built.text], built.name, { type: "text/markdown" });
    const payload =
      typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })
        ? { files: [file], title }
        : { text, title };

    try {
      await navigator.share(payload);
    } catch (error) {
      // Cancelling is a normal outcome, not a failure to report.
      if (error && error.name === "AbortError") return;
      console.error("[scribe] share failed", error);
      setStatus("Could not open the share sheet");
    }
  });

  refresh();
  return { refresh };
}
