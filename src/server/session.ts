import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { Transcript } from "./transcript.js";
import { EventBroker } from "./events.js";
import type { RunningSummary } from "./claude.js";

/** Groq whisper-large-v3-turbo list price, USD per hour of audio. */
const GROQ_USD_PER_AUDIO_HOUR = 0.04;

export interface SessionDeps {
  transcribe(input: { audio: Buffer; prompt?: string }): Promise<string>;
  running(transcript: string, previous: RunningSummary | null): Promise<RunningSummary>;
  final(transcript: string): Promise<string>;
  now?: () => number;
}

export class Session {
  readonly events = new EventBroker();
  private readonly transcript: Transcript;
  private summary: RunningSummary | null = null;
  private lastSummaryAt: number;
  private lastSummarisedIndex = 0;
  private failedChunks = 0;
  private audioSeconds = 0;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly id: string,
    readonly dir: string,
    private readonly config: Config,
    private readonly deps: SessionDeps,
  ) {
    this.transcript = new Transcript(path.join(dir, "transcript.md"));
    this.lastSummaryAt = this.now();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  static async create(config: Config, deps: SessionDeps): Promise<Session> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const id = `${stamp.slice(0, 10)}-${stamp.slice(11, 19)}`;
    const dir = path.join(config.sessionsDir, id);
    await mkdir(dir, { recursive: true });
    if (config.keepAudio) await mkdir(path.join(dir, "audio"), { recursive: true });
    return new Session(id, dir, config, deps);
  }

  /**
   * Chunks are serialised through a promise chain so the Whisper bias prompt
   * always reflects everything transcribed before this chunk. Never rejects —
   * a thrown error here would propagate to the upload handler and, through it,
   * to the browser's capture loop.
   */
  async ingestChunk(input: {
    index: number;
    startMs: number;
    endMs: number;
    audio: Buffer;
  }): Promise<void> {
    this.queue = this.queue.then(() => this.processChunk(input));
    await this.queue;
  }

  private async processChunk(input: {
    index: number;
    startMs: number;
    endMs: number;
    audio: Buffer;
  }): Promise<void> {
    const { index, startMs, endMs } = input;
    try {
      if (this.config.keepAudio) {
        const name = `${String(index).padStart(4, "0")}.wav`;
        await writeFile(path.join(this.dir, "audio", name), input.audio);
      }

      this.audioSeconds += (endMs - startMs) / 1000;

      const prompt = this.transcript.tail(200) || undefined;
      let line;
      try {
        const text = await this.deps.transcribe({ audio: input.audio, prompt });
        // Explicit fields, never `...input`: that would carry the WAV Buffer
        // into the TranscriptLine and out over SSE as JSON on every chunk.
        line = text
          ? this.transcript.record({ index, startMs, endMs, text })
          : this.transcript.recordFailure({ index, startMs, endMs });
      } catch (error) {
        console.error(`[scribe] chunk ${index} transcription failed:`, error);
        this.failedChunks += 1;
        line = this.transcript.recordFailure({ index, startMs, endMs });
      }

      await this.transcript.flush();
      this.events.publish({ type: "transcript", line });
      this.publishStatus();
      await this.maybeSummarise();
    } catch (error) {
      // Last line of defence. Recording continues regardless of what broke.
      console.error(`[scribe] chunk ${index} handling failed:`, error);
    }
  }

  private publishStatus(): void {
    this.events.publish({
      type: "status",
      failedChunks: this.failedChunks,
      audioSeconds: this.audioSeconds,
      estimatedCostUsd: (this.audioSeconds / 3600) * GROQ_USD_PER_AUDIO_HOUR,
    });
  }

  private async maybeSummarise(): Promise<void> {
    const elapsedMs = this.now() - this.lastSummaryAt;
    if (elapsedMs < this.config.summaryIntervalMinutes * 60_000) return;
    if (this.transcript.lastIndex() === this.lastSummarisedIndex) return;

    this.lastSummaryAt = this.now();
    const lastIndex = this.transcript.lastIndex();

    try {
      this.summary = await this.deps.running(this.transcript.fullText(), this.summary);
      this.lastSummarisedIndex = lastIndex;
      this.events.publish({ type: "summary", summary: this.summary });
    } catch (error) {
      // Leave the previous summary standing and try again next interval.
      console.error("[scribe] running summary failed:", error);
    }
  }

  async stop(): Promise<string> {
    await this.queue;
    await this.transcript.flush();

    let markdown = "";
    try {
      markdown = await this.deps.final(this.transcript.fullText());
      await writeFile(path.join(this.dir, "summary.md"), `${markdown}\n`, "utf8");
      this.events.publish({ type: "final", markdown });
    } catch (error) {
      console.error("[scribe] final summary failed:", error);
    }

    // Never serialise the config object itself — it holds both API keys.
    await writeFile(
      path.join(this.dir, "meta.json"),
      JSON.stringify(
        {
          id: this.id,
          audioSeconds: this.audioSeconds,
          failedChunks: this.failedChunks,
          chunks: this.transcript.lastIndex(),
          runningModel: this.config.runningModel,
          finalModel: this.config.finalModel,
          estimatedGroqCostUsd: (this.audioSeconds / 3600) * GROQ_USD_PER_AUDIO_HOUR,
        },
        null,
        2,
      ),
      "utf8",
    );

    return markdown;
  }
}
