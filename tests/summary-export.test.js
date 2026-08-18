import { describe, it, expect } from "vitest";
import { summaryToPlainText, sanitiseFilename } from "../src/web/summary-export.js";

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
