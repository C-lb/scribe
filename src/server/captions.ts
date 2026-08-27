import type { TranscriptLine } from "./transcript.js";

/**
 * Excludes a failed chunk. `[inaudible ~MM:SS]` is a placeholder the
 * recorder writes in place of speech it could not transcribe, and writing
 * it into a caption or text export would read as if someone actually said
 * that, rather than as the gap it is.
 */
function spokenLines(lines: TranscriptLine[]): TranscriptLine[] {
  return lines.filter((line) => !line.failed).sort((a, b) => a.index - b.index);
}

/**
 * `HH:MM:SS` plus milliseconds, with the millisecond separator left to the
 * caller: SRT uses a comma there, VTT a dot, and nothing else about the two
 * formats' cue timing differs.
 */
function formatCueTime(ms: number, msSeparator: string): string {
  const totalMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return (
    `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}${msSeparator}${String(millis).padStart(3, "0")}`
  );
}

/**
 * Cues are numbered from one in sequence, never from the chunk's own
 * `index`. A dropped chunk (a silence artefact) leaves a hole in the index
 * sequence, and a caption file with a gap in its cue numbers is malformed
 * even though nothing is actually missing from the export.
 */
export function toSrt(lines: TranscriptLine[]): string {
  return spokenLines(lines)
    .map((line, i) => {
      const start = formatCueTime(line.startMs, ",");
      const end = formatCueTime(line.endMs, ",");
      return `${i + 1}\n${start} --> ${end}\n${line.text}\n`;
    })
    .join("\n");
}

export function toVtt(lines: TranscriptLine[]): string {
  const cues = spokenLines(lines)
    .map((line, i) => {
      const start = formatCueTime(line.startMs, ".");
      const end = formatCueTime(line.endMs, ".");
      return `${i + 1}\n${start} --> ${end}\n${line.text}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${cues}`;
}

/** No timestamps, no cue numbers: paragraphs of running text, the same
 *  shape a reader would paste into a notes app. */
export function toPlainText(lines: TranscriptLine[]): string {
  return `${spokenLines(lines)
    .map((line) => line.text)
    .join("\n\n")}\n`;
}
