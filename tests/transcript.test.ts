import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transcript, formatTimestamp } from "../src/server/transcript.js";

async function tempFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "scribe-"));
  return path.join(dir, "transcript.md");
}

describe("formatTimestamp", () => {
  it("formats as mm:ss", () => {
    expect(formatTimestamp(0)).toBe("00:00");
    expect(formatTimestamp(65_000)).toBe("01:05");
  });

  it("keeps counting minutes past an hour rather than wrapping", () => {
    expect(formatTimestamp(3_720_000)).toBe("62:00");
  });
});

describe("Transcript", () => {
  it("orders lines by index even when recorded out of order", async () => {
    const t = new Transcript(await tempFile());
    t.record({ index: 2, startMs: 20_000, endMs: 40_000, text: "second" });
    t.record({ index: 1, startMs: 0, endMs: 20_000, text: "first" });
    expect(t.lines().map((l) => l.text)).toEqual(["first", "second"]);
  });

  it("marks a failed chunk inline without dropping its neighbours", async () => {
    const t = new Transcript(await tempFile());
    t.record({ index: 1, startMs: 0, endMs: 20_000, text: "before" });
    t.recordFailure({ index: 2, startMs: 20_000, endMs: 40_000 });
    t.record({ index: 3, startMs: 40_000, endMs: 60_000, text: "after" });

    const lines = t.lines();
    expect(lines).toHaveLength(3);
    expect(lines[1].failed).toBe(true);
    expect(lines[1].text).toBe("[inaudible ~00:20]");
    expect(t.fullText()).toContain("before");
    expect(t.fullText()).toContain("after");
  });

  it("returns only text recorded after a given index", async () => {
    const t = new Transcript(await tempFile());
    t.record({ index: 1, startMs: 0, endMs: 1000, text: "one" });
    t.record({ index: 2, startMs: 1000, endMs: 2000, text: "two" });
    t.record({ index: 3, startMs: 2000, endMs: 3000, text: "three" });
    expect(t.textSince(1)).toBe("two three");
  });

  it("returns the trailing characters for the Whisper bias prompt", async () => {
    const t = new Transcript(await tempFile());
    t.record({ index: 1, startMs: 0, endMs: 1000, text: "alpha beta gamma" });
    expect(t.tail(5)).toBe("gamma");
  });

  it("excludes inaudible markers from the Whisper bias prompt", async () => {
    const t = new Transcript(await tempFile());
    t.record({ index: 1, startMs: 0, endMs: 1000, text: "real words here" });
    t.recordFailure({ index: 2, startMs: 1000, endMs: 2000 });
    expect(t.tail(100)).toBe("real words here");
  });

  it("rewrites the whole file on flush so ordering survives a restart", async () => {
    const file = await tempFile();
    const t = new Transcript(file);
    t.record({ index: 2, startMs: 20_000, endMs: 40_000, text: "second" });
    t.record({ index: 1, startMs: 0, endMs: 20_000, text: "first" });
    await t.flush();

    const written = await readFile(file, "utf8");
    expect(written.indexOf("first")).toBeLessThan(written.indexOf("second"));
    expect(written).toContain("[00:00]");
  });

  it("reports the highest recorded index", async () => {
    const t = new Transcript(await tempFile());
    expect(t.lastIndex()).toBe(0);
    t.record({ index: 7, startMs: 0, endMs: 1000, text: "x" });
    expect(t.lastIndex()).toBe(7);
  });
});
