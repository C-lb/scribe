import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface TranscriptLine {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  failed: boolean;
  /** Set once a human has corrected this line's text. Task 1 only adds the
   *  field; nothing writes it yet. */
  edited?: boolean;
}

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export class Transcript {
  private byIndex = new Map<number, TranscriptLine>();

  constructor(private readonly filePath: string) {}

  record(line: Omit<TranscriptLine, "failed">): TranscriptLine {
    const entry: TranscriptLine = { ...line, text: line.text.trim(), failed: false };
    this.byIndex.set(entry.index, entry);
    return entry;
  }

  recordFailure(meta: { index: number; startMs: number; endMs: number }): TranscriptLine {
    const entry: TranscriptLine = {
      ...meta,
      text: `[inaudible ~${formatTimestamp(meta.startMs)}]`,
      failed: true,
    };
    this.byIndex.set(entry.index, entry);
    return entry;
  }

  lines(): TranscriptLine[] {
    return [...this.byIndex.values()].sort((a, b) => a.index - b.index);
  }

  lastIndex(): number {
    return this.byIndex.size === 0 ? 0 : Math.max(...this.byIndex.keys());
  }

  fullText(): string {
    return this.lines().map((l) => l.text).join(" ").trim();
  }

  textSince(index: number): string {
    return this.lines()
      .filter((l) => l.index > index)
      .map((l) => l.text)
      .join(" ")
      .trim();
  }

  /** Trailing transcript text used to bias Whisper on the next chunk. */
  tail(chars: number): string {
    const spoken = this.lines()
      .filter((l) => !l.failed)
      .map((l) => l.text)
      .join(" ")
      .trim();
    return spoken.slice(-chars);
  }

  toMarkdown(): string {
    return this.lines()
      .map((l) => `[${formatTimestamp(l.startMs)}] ${l.text}`)
      .join("\n\n");
  }

  /**
   * Rewrite the file in full. Chunks can land out of order after a retry, and
   * appending would bake that order into the file permanently.
   */
  async flush(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${this.toMarkdown()}\n`, "utf8");
  }
}
