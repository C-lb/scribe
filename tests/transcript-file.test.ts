import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeTranscriptFile, readLines, parseMarkdownLines } from "../src/server/transcript-file.js";
import { chunkFileName, CHUNK_FILE_PATTERN } from "../src/shared/filename.js";

const line = (index: number, startMs: number, text: string) => ({
  index, startMs, endMs: startMs + 20_000, text, failed: false,
});

describe("readLines", () => {
  it("prefers transcript.json and keeps the real chunk indexes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scribe-"));
    // index 1 is missing: it was dropped as a silence artefact.
    await writeTranscriptFile(dir, {
      version: 1,
      lines: [line(0, 0, "Raft elects a leader"), line(2, 40_000, "The term number rises")],
      flags: [{ atMs: 40_000, chunkIndex: 2 }],
    });

    const read = await readLines(dir);
    expect(read.structured).toBe(true);
    expect(read.lines.map((l) => l.index)).toEqual([0, 2]);
    expect(read.flags).toEqual([{ atMs: 40_000, chunkIndex: 2 }]);
  });

  it("falls back to transcript.md for sessions recorded before this existed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scribe-"));
    await writeFile(path.join(dir, "transcript.md"), "[00:00] First line\n\n[00:20] Second line\n");

    const read = await readLines(dir);
    expect(read.structured).toBe(false);
    expect(read.lines).toEqual([
      { index: 0, startMs: 0, endMs: 20_000, text: "First line", failed: false },
      { index: 1, startMs: 20_000, endMs: 40_000, text: "Second line", failed: false },
    ]);
  });

  it("returns nothing for a directory with neither file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scribe-"));
    expect(await readLines(dir)).toEqual({ lines: [], flags: [], structured: false });
  });
});

describe("parseMarkdownLines", () => {
  it("marks an inaudible line as failed", () => {
    expect(parseMarkdownLines("[01:00] [inaudible ~01:00]")).toEqual([
      { index: 0, startMs: 60_000, endMs: 80_000, text: "[inaudible ~01:00]", failed: true },
    ]);
  });
});

describe("a corrupt transcript.json", () => {
  it("is kept aside rather than overwritten, and the fallback is logged loudly", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scribe-"));
    await writeFile(path.join(dir, "transcript.json"), "{ this is not json", "utf8");
    await writeFile(path.join(dir, "transcript.md"), "[00:00] First line\n", "utf8");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const read = await readLines(dir);

    // The Markdown fallback is a real loss: no flags, and indexes renumbered
    // by position, so it must never happen quietly.
    expect(read.structured).toBe(false);
    expect(logged.mock.calls.flat().join(" ")).toContain("did not parse");

    // The bytes survive, under a name the next flush cannot overwrite, so the
    // real chunk indexes can be recovered by hand.
    const names = await readdir(dir);
    const kept = names.find((n) => n.startsWith("transcript.corrupt-"));
    expect(kept).toBeDefined();
    expect(await readFile(path.join(dir, kept!), "utf8")).toBe("{ this is not json");
    expect(names).not.toContain("transcript.json");

    logged.mockRestore();
  });
});

describe("chunkFileName", () => {
  it("pads to the four digits every reader and the writer agree on", () => {
    expect(chunkFileName(0)).toBe("0000.wav");
    expect(chunkFileName(42)).toBe("0042.wav");
    expect(CHUNK_FILE_PATTERN.test(chunkFileName(7))).toBe(true);
    expect(CHUNK_FILE_PATTERN.test("full.wav")).toBe(false);
  });
});
