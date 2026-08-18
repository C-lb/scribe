import { describe, it, expect } from "vitest";
import "dotenv/config";
import { loadConfig } from "../../src/server/config.js";
import { createSummariser } from "../../src/server/claude.js";

const live = process.env.SCRIBE_LIVE_TESTS === "1";

const TRANSCRIPT = `
Today we're looking at opportunity cost. Opportunity cost is the value of the
next best alternative you give up when you make a choice. This will be on the
midterm, so make sure you can apply it, not just define it. Someone asked
whether sunk costs count, and we'll come back to that next week.
`.trim();

describe.skipIf(!live)("Claude summarisation (live)", () => {
  it("returns a structured running summary", async () => {
    const summariser = createSummariser(loadConfig());
    const summary = await summariser.running(TRANSCRIPT, null);

    expect(Array.isArray(summary.topics)).toBe(true);
    expect(summary.definitions.some((d) => /opportunity cost/i.test(d.term))).toBe(true);
    expect(summary.flagged.join(" ")).toMatch(/midterm/i);
    expect(summary.openQuestions.join(" ")).toMatch(/sunk cost/i);
  }, 120_000);

  it("returns Markdown from the final pass", async () => {
    const summariser = createSummariser(loadConfig());
    const markdown = await summariser.final(TRANSCRIPT);
    expect(markdown.length).toBeGreaterThan(50);
    expect(markdown).toMatch(/opportunity cost/i);
  }, 180_000);
});
