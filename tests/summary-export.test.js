import { describe, it, expect } from "vitest";
import {
  buildMarkdownFile,
  exportState,
  sanitiseFilename,
  summaryToPlainText,
} from "../src/web/summary-export.js";

const running = (over = {}) => ({
  topics: [], keyPoints: [], definitions: [], flagged: [], openQuestions: [], ...over,
});

describe("summaryToPlainText, running summaries", () => {
  it("renders every populated section with bullets", () => {
    const text = summaryToPlainText({
      kind: "running",
      summary: running({
        topics: ["Consensus"],
        keyPoints: ["Quorums overlap"],
        definitions: [{ term: "Quorum", definition: "A majority of nodes" }],
        flagged: ["On the exam"],
        openQuestions: ["What about partitions?"],
      }),
    });

    expect(text).toBe(
      [
        "Topics",
        "• Consensus",
        "",
        "Key points",
        "• Quorums overlap",
        "",
        "Definitions",
        "• Quorum — A majority of nodes",
        "",
        "Flagged",
        "• On the exam",
        "",
        "Open questions",
        "• What about partitions?",
      ].join("\n"),
    );
  });

  it("omits empty sections rather than printing bare headings", () => {
    const text = summaryToPlainText({ kind: "running", summary: running({ topics: ["Only this"] }) });
    expect(text).toBe("Topics\n• Only this");
  });

  it("returns an empty string for a summary with nothing in it", () => {
    expect(summaryToPlainText({ kind: "running", summary: running() })).toBe("");
  });

  it("skips definition entries with neither term nor definition", () => {
    const text = summaryToPlainText({
      kind: "running",
      summary: running({
        definitions: [
          { term: "Valid", definition: "Has both" },
          { term: undefined, definition: undefined },
          { term: "Another", definition: "Also valid" }
        ]
      })
    });
    expect(text).toBe(
      [
        "Definitions",
        "• Valid — Has both",
        "• Another — Also valid"
      ].join("\n")
    );
  });

  it("emits only term when definition is missing", () => {
    const text = summaryToPlainText({
      kind: "running",
      summary: running({
        definitions: [
          { term: "Quorum", definition: undefined },
          { term: undefined, definition: "A majority of nodes" }
        ]
      })
    });
    expect(text).toBe(
      [
        "Definitions",
        "• Quorum",
        "• A majority of nodes"
      ].join("\n")
    );
  });
});

describe("summaryToPlainText, markdown summaries", () => {
  it("flattens headings, bullets, and inline emphasis", () => {
    const markdown = [
      "# Lecture notes",
      "",
      "## Overview",
      "",
      "The lecture covered **consensus** and *quorums*.",
      "",
      "- First point",
      "- Second point",
      "  - A nested one",
      "",
      "1. Numbered too",
    ].join("\n");

    expect(summaryToPlainText({ kind: "markdown", markdown })).toBe(
      [
        "Lecture notes",
        "",
        "Overview",
        "",
        "The lecture covered consensus and quorums.",
        "",
        "• First point",
        "• Second point",
        "  ◦ A nested one",
        "",
        "• Numbered too",
      ].join("\n"),
    );
  });

  it("strips code fences and inline code markers", () => {
    expect(summaryToPlainText({ kind: "markdown", markdown: "Use `raft` here" })).toBe("Use raft here");
  });

  it("collapses runs of blank lines to one", () => {
    expect(summaryToPlainText({ kind: "markdown", markdown: "A\n\n\n\nB" })).toBe("A\n\nB");
  });

  it("returns an empty string for empty or whitespace-only markdown", () => {
    expect(summaryToPlainText({ kind: "markdown", markdown: "   \n\n" })).toBe("");
  });

  it("preserves underscores in identifiers and snake_case names", () => {
    expect(summaryToPlainText({
      kind: "markdown",
      markdown: "the resample_buffer function and snake_case names"
    })).toBe("the resample_buffer function and snake_case names");
  });

  it("preserves asterisks in arithmetic expressions", () => {
    expect(summaryToPlainText({
      kind: "markdown",
      markdown: "the area is 2 * 3 * 4 units"
    })).toBe("the area is 2 * 3 * 4 units");
  });

  it("still strips real emphasis markers", () => {
    expect(summaryToPlainText({ kind: "markdown", markdown: "*emphasis*" })).toBe("emphasis");
    expect(summaryToPlainText({ kind: "markdown", markdown: "_emphasis_" })).toBe("emphasis");
    expect(summaryToPlainText({ kind: "markdown", markdown: "**bold**" })).toBe("bold");
  });

  it("strips trailing hashes from ATX headings", () => {
    const markdown = "## Overview ##\n\nSome content";
    expect(summaryToPlainText({ kind: "markdown", markdown })).toBe("Overview\n\nSome content");
  });

  it("drops horizontal rules", () => {
    const markdown = ["Line 1", "---", "Line 2", "", "***", "", "Line 3"].join("\n");
    expect(summaryToPlainText({ kind: "markdown", markdown })).toBe("Line 1\nLine 2\n\nLine 3");
  });
});

describe("sanitiseFilename", () => {
  it("lowercases and hyphenates a title", () => {
    expect(sanitiseFilename("Raft and Consensus", "2026-08-18-17-03-30")).toBe("raft-and-consensus");
  });

  it("drops characters outside letters, digits, hyphens, and underscores", () => {
    expect(sanitiseFilename("BUSI 520: Week #3 (draft)", "id")).toBe("busi-520-week-3-draft");
  });

  it("falls back to the session id when the title sanitises down to nothing", () => {
    expect(sanitiseFilename("←→", "2026-08-18-17-03-30")).toBe("2026-08-18-17-03-30");
    expect(sanitiseFilename("", "2026-08-18-17-03-30")).toBe("2026-08-18-17-03-30");
  });
});

describe("exportState", () => {
  it("is disabled and explains itself while the first summary is still coming", () => {
    expect(exportState({ input: null, recording: true })).toEqual({
      enabled: false,
      reason: "The first summary appears after about five minutes.",
    });
  });

  it("is disabled and honest when a finished session has no summary at all", () => {
    expect(exportState({ input: null, recording: false })).toEqual({
      enabled: false,
      reason: "The summary for this session failed, so there is nothing to send.",
    });
  });

  it("is enabled once there is any summary", () => {
    expect(exportState({ input: { kind: "markdown", markdown: "# x" }, recording: false })).toEqual({
      enabled: true,
      reason: "",
    });
  });
});

describe("buildMarkdownFile", () => {
  it("names the file from the title and leads with it as a heading", () => {
    const file = buildMarkdownFile({
      title: "Raft and Consensus",
      sessionId: "2026-08-18-17-03-30",
      markdown: "## Overview\n\nSomething.\n",
    });
    expect(file.name).toBe("raft-and-consensus.md");
    expect(file.text).toBe("# Raft and Consensus\n\n## Overview\n\nSomething.\n");
  });

  it("does not repeat a heading the markdown already opens with", () => {
    const file = buildMarkdownFile({
      title: "Raft",
      sessionId: "id",
      markdown: "# Raft\n\nBody.\n",
    });
    expect(file.text).toBe("# Raft\n\nBody.\n");
  });
});
