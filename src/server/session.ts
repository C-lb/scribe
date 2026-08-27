import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { Transcript } from "./transcript.js";
import { writeTranscriptFile, type TranscriptFlag } from "./transcript-file.js";
import { EventBroker } from "./events.js";
import { filterChunkText } from "./hallucination.js";
import { promptPrefix, correct } from "./glossary.js";
import { joinWavs } from "./wav-join.js";
import type { RunningSummary } from "./claude.js";
import { appendFlagsSection } from "./claude.js";

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
  /** Chunks whose whole transcript was a Whisper silence artefact, dropped unwritten. */
  private silenceArtefacts = 0;
  private audioSeconds = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private recording = true;
  /** Filled in Task 4. Persisted on every write so a flag survives a restart. */
  private flags: TranscriptFlag[] = [];

  get isRecording(): boolean {
    return this.recording;
  }

  private constructor(
    readonly id: string,
    readonly dir: string,
    private readonly config: Config,
    private readonly deps: SessionDeps,
    /** The course's term list, bound in at creation and fixed for the whole
     *  recording -- the same "fixed once recording starts" rule the course
     *  picker in the header enforces on the browser side. */
    private readonly terms: string[],
  ) {
    this.transcript = new Transcript(path.join(dir, "transcript.md"));
    this.lastSummaryAt = this.now();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  static async create(config: Config, deps: SessionDeps, terms: string[] = []): Promise<Session> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const id = `${stamp.slice(0, 10)}-${stamp.slice(11, 19)}`;
    const dir = path.join(config.sessionsDir, id);
    await mkdir(dir, { recursive: true });
    if (config.keepAudio) await mkdir(path.join(dir, "audio"), { recursive: true });
    return new Session(id, dir, config, deps, terms);
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

      // Terms go in front of the trailing transcript, not instead of it.
      // Whisper's prompt is a bias, not a rule, and the tail is what keeps a
      // sentence continuous across a chunk boundary.
      const prefix = promptPrefix(this.terms);
      const tail = this.transcript.tail(200);
      const prompt = [prefix, tail].filter(Boolean).join(" ") || undefined;
      let line;
      try {
        const raw = await this.deps.transcribe({ audio: input.audio, prompt });
        // Corrected here rather than at read time, so a drifted term never
        // reaches the next chunk's bias prompt. That feedback loop is what
        // turned one bad "RAF" into every later chunk saying "RAF".
        const text = correct(filterChunkText(raw), this.terms);

        // A chunk the filter emptied is a silence artefact, not a failure, and
        // not a line. Recording nothing is the whole point: an artefact written
        // down would go straight back out as the next chunk's bias prompt and
        // raise the odds of the same phrase again. See hallucination.ts.
        if (raw && !text) {
          console.info(`[scribe] chunk ${index} dropped a silence artefact: ${JSON.stringify(raw)}`);
          this.silenceArtefacts += 1;
          await this.persist();
          this.publishStatus();
          await this.maybeSummarise();
          return;
        }

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

      // A flag pressed while this chunk was still recording had no line to
      // resolve against yet -- that's the common case, since a flag marks
      // "right now" and a chunk takes ~20s to come back transcribed. Now
      // that the line exists, any flag still sitting on `null` whose
      // timestamp falls inside it gets backfilled, before persist() writes
      // it out. Without this the flag would keep `chunkIndex: null` forever,
      // and the final document's "Marked in the room" section would quote
      // the placeholder instead of what the lecturer actually said -- the
      // common case, not the exception.
      for (const flag of this.flags) {
        if (flag.chunkIndex === null && flag.atMs >= line.startMs && flag.atMs < line.endMs) {
          flag.chunkIndex = line.index;
        }
      }

      await this.persist();
      this.events.publish({ type: "transcript", line });
      this.publishStatus();
      await this.maybeSummarise();
    } catch (error) {
      // Last line of defence. Recording continues regardless of what broke.
      console.error(`[scribe] chunk ${index} handling failed:`, error);
    }
  }

  /** transcript.md stays the human artefact; transcript.json is the one the app
   *  reads back, because Markdown loses the chunk index and the millisecond. */
  private async persist(): Promise<void> {
    await this.transcript.flush();
    await writeTranscriptFile(this.dir, {
      version: 1,
      lines: this.transcript.lines(),
      flags: this.flags,
    }).catch((error) => console.error("[scribe] failed to write transcript.json:", error));
  }

  /** A flag is a timestamp, nothing more. Resolving it to a chunk is best
   *  effort: a flag dropped during the chunk still being recorded has no line
   *  yet, and chunkIndex stays null until the transcript catches up. It is
   *  backfilled in processChunk() the moment a line covering that timestamp
   *  is recorded, so the common case (a flag landing before its own chunk
   *  comes back transcribed) still resolves.
   *
   *  The persist below is routed through the same `this.queue` chain
   *  processChunk() serialises its own persist() calls through, rather than
   *  fired off on its own. writeTranscriptFile() always writes to one fixed
   *  temp path before renaming it into place, so two writers in flight at
   *  once can clobber each other's temp file and leave transcript.json
   *  stale against memory -- exactly one writer, strictly ordered, is what
   *  keeps that from happening. */
  flag(atMs: number): TranscriptFlag {
    const line = this.transcript.lines().find((l) => atMs >= l.startMs && atMs < l.endMs);
    const flag: TranscriptFlag = { atMs, chunkIndex: line?.index ?? null };
    this.flags.push(flag);
    this.events.publish({ type: "flag", flag });
    this.queue = this.queue.then(() => this.persist());
    return flag;
  }

  private publishStatus(): void {
    this.events.publish({
      type: "status",
      failedChunks: this.failedChunks,
      silenceArtefacts: this.silenceArtefacts,
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

      // Persisted so a session whose final summary failed still has something
      // to display and to export. Failing to write it must not stop the
      // recording, so it is caught here rather than propagating.
      await writeFile(
        path.join(this.dir, "running-summary.json"),
        `${JSON.stringify(this.summary, null, 2)}\n`,
        "utf8",
      ).catch((error) => console.error("[scribe] failed to save running summary:", error));
    } catch (error) {
      // Leave the previous summary standing and try again next interval.
      console.error("[scribe] running summary failed:", error);
    }
  }

  async stop(): Promise<string> {
    try {
      await this.queue;
      await this.persist();

      let markdown = "";
      try {
        const raw = await this.deps.final(this.transcript.fullText());
        // Appended after the model returns, never asked for in the prompt:
        // the flags are ground truth from the person in the room, and a
        // model handed them as prose might paraphrase or drop one.
        markdown = appendFlagsSection(raw, this.flags, this.transcript.lines());
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
            silenceArtefacts: this.silenceArtefacts,
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

      // One file the whole lecture scrubs through. The chunk files stay: they
      // are what a single line plays, and joining them again is cheap.
      if (this.config.keepAudio) {
        try {
          const names = (await readdir(path.join(this.dir, "audio")))
            .filter((n) => n.endsWith(".wav") && n !== "full.wav")
            .sort();
          const buffers = await Promise.all(
            names.map((n) => readFile(path.join(this.dir, "audio", n))),
          );
          await writeFile(path.join(this.dir, "audio", "full.wav"), joinWavs(buffers));
        } catch (error) {
          console.error("[scribe] could not write full.wav:", error);
        }
      }

      return markdown;
    } finally {
      // Whatever went wrong above — a transcript flush, the meta.json write —
      // this session has stopped. Letting the flag survive the throw would
      // leave the drawer showing it as "Recording" for the life of the
      // process, and a live row cannot be opened for reading.
      this.recording = false;
    }
  }
}
