import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TranscriptLine } from "./transcript.js";

export interface TranscriptFlag {
  atMs: number;
  chunkIndex: number | null;
  note?: string;
}

export interface TranscriptFileV1 {
  version: 1;
  lines: TranscriptLine[];
  flags: TranscriptFlag[];
}

export function transcriptJsonPath(dir: string): string {
  return path.join(dir, "transcript.json");
}

/**
 * Write via a temp file plus rename rather than a direct write. `rename` is
 * atomic on the same filesystem, so a crash mid-write leaves either the old
 * transcript.json intact or the new one, never a half-written file that
 * `readLines` would have to fail on.
 */
export async function writeTranscriptFile(dir: string, file: TranscriptFileV1): Promise<void> {
  const target = transcriptJsonPath(dir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

/**
 * Returns null both when the file is absent and when it fails to parse. A
 * corrupt transcript.json (partial write from an older bug, disk corruption)
 * must degrade to the Markdown fallback, never make the session unreadable.
 */
export async function readTranscriptFile(dir: string): Promise<TranscriptFileV1 | null> {
  let raw: string;
  try {
    raw = await readFile(transcriptJsonPath(dir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[scribe] failed to read transcript.json:", error);
    }
    return null;
  }

  try {
    return JSON.parse(raw) as TranscriptFileV1;
  } catch (error) {
    await quarantineCorruptFile(dir, error);
    return null;
  }
}

/**
 * The Markdown fallback is a real loss, not a graceful one: it drops every
 * flag and renumbers the lines by position, so a session with a dropped
 * silence artefact in it has click-to-play pointing at the wrong
 * audio/NNNN.wav from then on, with nothing on screen to say so. Worse, the
 * next flush overwrites the corrupt file and the real indexes are gone for
 * good.
 *
 * So the corrupt file is moved aside under a timestamped name before anything
 * can overwrite it, and the loss is logged loudly rather than swallowed. The
 * bytes stay on disk next to the session for as long as it takes someone to
 * pull the indexes back out by hand.
 */
async function quarantineCorruptFile(dir: string, error: unknown): Promise<void> {
  const source = transcriptJsonPath(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const kept = path.join(dir, `transcript.corrupt-${stamp}.json`);
  try {
    await rename(source, kept);
  } catch (renameError) {
    console.error(`[scribe] could not preserve the corrupt transcript.json in ${dir}:`, renameError);
    return;
  }
  console.error(
    `[scribe] transcript.json in ${dir} did not parse and has been kept as ${path.basename(kept)}. ` +
      "The transcript now falls back to transcript.md, which has no flags and renumbers lines by " +
      "position, so click-to-play may point at the wrong chunk. The real chunk indexes are " +
      "recoverable by hand from the kept file.",
    error,
  );
}

const INAUDIBLE = /^\[inaudible ~\d\d:\d\d\]$/;

/**
 * Markdown lines carry only a timestamp and text, so the chunk index is just
 * the line's position here. That is exactly the bug this file exists to fix
 * for sessions recorded going forward: a legacy session that predates
 * transcript.json has no better data to recover the real chunk index from,
 * so this is the best-effort fallback, not the source of truth.
 */
export function parseMarkdownLines(markdown: string): TranscriptLine[] {
  const blocks = markdown
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean);

  const parsed = blocks
    .map((block) => {
      const match = block.match(/^\[(\d\d):(\d\d)\]\s*([\s\S]*)$/);
      if (!match) return null;
      const [, mm, ss, text] = match;
      const startMs = (Number(mm) * 60 + Number(ss)) * 1000;
      return { startMs, text: text.trim() };
    })
    .filter((x): x is { startMs: number; text: string } => x !== null);

  return parsed.map((entry, index) => {
    // The chunk length isn't recoverable from Markdown, so the last line's
    // endMs is an estimate (startMs + 20s, the typical chunk length) rather
    // than a real boundary. Callers of a fallback session should treat
    // endMs as approximate.
    const next = parsed[index + 1];
    const endMs = next ? next.startMs : entry.startMs + 20_000;
    return {
      index,
      startMs: entry.startMs,
      endMs,
      text: entry.text,
      failed: INAUDIBLE.test(entry.text),
    };
  });
}

export async function readLines(
  dir: string,
): Promise<{ lines: TranscriptLine[]; flags: TranscriptFlag[]; structured: boolean }> {
  const structuredFile = await readTranscriptFile(dir);
  if (structuredFile) {
    return { lines: structuredFile.lines, flags: structuredFile.flags, structured: true };
  }

  try {
    const markdown = await readFile(path.join(dir, "transcript.md"), "utf8");
    return { lines: parseMarkdownLines(markdown), flags: [], structured: false };
  } catch {
    return { lines: [], flags: [], structured: false };
  }
}
