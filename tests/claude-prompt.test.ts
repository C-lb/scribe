import { describe, it, expect } from "vitest";
import {
  buildRunningMessages,
  RUNNING_SYSTEM_PROMPT,
  appendFlagsSection,
} from "../src/server/claude.js";

const previous = {
  topics: ["intro"],
  keyPoints: [],
  definitions: [],
  flagged: [],
  openQuestions: [],
};

function blocks(messages: ReturnType<typeof buildRunningMessages>) {
  const content = messages[0].content;
  if (typeof content === "string") throw new Error("expected content blocks");
  return content as Array<{ type: string; text: string; cache_control?: unknown }>;
}

describe("buildRunningMessages", () => {
  it("puts the transcript before the previous summary", () => {
    const b = blocks(buildRunningMessages("some transcript text", previous));
    const transcriptIndex = b.findIndex((x) => x.text.includes("some transcript text"));
    const previousIndex = b.findIndex((x) => x.text.includes("intro"));
    expect(transcriptIndex).toBeGreaterThanOrEqual(0);
    expect(previousIndex).toBeGreaterThan(transcriptIndex);
  });

  it("marks the transcript block as cacheable with a one-hour TTL", () => {
    const b = blocks(buildRunningMessages("some transcript text", previous));
    const transcriptBlock = b.find((x) => x.text.includes("some transcript text"));
    expect(transcriptBlock?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("does not mark the volatile trailing block as cacheable", () => {
    const b = blocks(buildRunningMessages("some transcript text", previous));
    expect(b[b.length - 1].cache_control).toBeUndefined();
  });

  it("handles a null previous summary", () => {
    const b = blocks(buildRunningMessages("first pass", null));
    expect(b.some((x) => x.text.includes("first pass"))).toBe(true);
  });

  it("keeps the transcript prefix byte-identical as the transcript grows", () => {
    // This is what makes prompt caching pay off: pass N+1's transcript block
    // must start with exactly pass N's bytes.
    const first = blocks(buildRunningMessages("aaa", null));
    const second = blocks(buildRunningMessages("aaa bbb", previous));
    const firstTranscript = first.find((x) => x.text.includes("aaa"))!.text;
    const secondTranscript = second.find((x) => x.text.includes("aaa"))!.text;
    const prefix = firstTranscript.slice(0, firstTranscript.indexOf("aaa") + 3);
    expect(secondTranscript.startsWith(prefix)).toBe(true);
  });
});

describe("RUNNING_SYSTEM_PROMPT", () => {
  it("contains no timestamp, date, or other varying token", () => {
    // A single varying byte in the prefix invalidates the whole cache.
    expect(RUNNING_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(RUNNING_SYSTEM_PROMPT).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});

describe("appendFlagsSection", () => {
  const lines = [
    { index: 0, startMs: 0, endMs: 20_000, text: "the first thing said", failed: false },
    { index: 1, startMs: 20_000, endMs: 40_000, text: "the second thing said", failed: false },
  ];

  it("appends a Marked in the room section with the timestamp and matching line", () => {
    const out = appendFlagsSection("# Notes", [{ atMs: 5_000, chunkIndex: 0 }], lines);
    expect(out).toContain("## Marked in the room");
    expect(out).toContain("**00:05**");
    expect(out).toContain("the first thing said");
  });

  it("leaves the markdown untouched when there are no flags, not even an empty heading", () => {
    const out = appendFlagsSection("# Notes", [], lines);
    expect(out).toBe("# Notes");
    expect(out).not.toContain("Marked in the room");
  });

  it("says so rather than inventing text when the flag never resolved to a chunk", () => {
    const out = appendFlagsSection("# Notes", [{ atMs: 5_000, chunkIndex: null }], lines);
    expect(out).toContain("**00:05**");
    expect(out).not.toContain("the first thing said");
  });
});
