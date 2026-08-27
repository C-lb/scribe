import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Session } from "../src/server/session.js";
import type { SessionDeps } from "../src/server/session.js";
import { loadConfig } from "../src/server/config.js";
import type { ScribeEvent } from "../src/server/events.js";

async function testConfig(overrides: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "scribe-sessions-"));
  return loadConfig({
    GROQ_API_KEY: "gsk_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    SCRIBE_SESSIONS_DIR: dir,
    SCRIBE_SUMMARY_INTERVAL_MINUTES: "5",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

const okDeps = () => ({
  transcribe: vi.fn().mockResolvedValue("hello world"),
  running: vi.fn().mockResolvedValue({
    topics: ["t"], keyPoints: [], definitions: [], flagged: [], openQuestions: [],
  }),
  final: vi.fn().mockResolvedValue("# Notes"),
});

const chunk = (index: number) => ({
  index,
  startMs: (index - 1) * 20_000,
  endMs: index * 20_000,
  audio: Buffer.from("fake wav"),
});

// Interval defaults to 0 so a running summary fires on the very first chunk
// without needing tests to fast-forward a clock.
async function makeSession(depsOverrides: Partial<SessionDeps> = {}) {
  const config = await testConfig({ SCRIBE_SUMMARY_INTERVAL_MINUTES: "0" });
  const deps = { ...okDeps(), ...depsOverrides };
  const session = await Session.create(config, deps);
  return { session, dir: session.dir };
}

describe("Session", () => {
  it("transcribes a chunk and publishes a transcript event", async () => {
    const session = await Session.create(await testConfig(), okDeps());
    const seen: ScribeEvent[] = [];
    session.events.subscribe((e) => seen.push(e));

    await session.ingestChunk(chunk(1));

    const line = seen.find((e) => e.type === "transcript");
    expect(line).toBeDefined();
    expect(line!.type === "transcript" && line!.line.text).toBe("hello world");
  });

  it("passes the previous transcript tail to Groq as a bias prompt", async () => {
    const deps = okDeps();
    const session = await Session.create(await testConfig(), deps);

    await session.ingestChunk(chunk(1));
    await session.ingestChunk(chunk(2));

    expect(deps.transcribe.mock.calls[0][0].prompt).toBeUndefined();
    expect(deps.transcribe.mock.calls[1][0].prompt).toContain("hello world");
  });

  it("records an inaudible marker when transcription fails, and keeps going", async () => {
    const deps = okDeps();
    deps.transcribe
      .mockRejectedValueOnce(new Error("groq down"))
      .mockResolvedValue("recovered");

    const session = await Session.create(await testConfig(), deps);
    await expect(session.ingestChunk(chunk(1))).resolves.toBeUndefined();
    await session.ingestChunk(chunk(2));

    const markdown = await readFile(path.join(session.dir, "transcript.md"), "utf8");
    expect(markdown).toContain("[inaudible ~00:00]");
    expect(markdown).toContain("recovered");
  });

  it("writes the audio chunk to disk", async () => {
    const session = await Session.create(await testConfig(), okDeps());
    await session.ingestChunk(chunk(1));
    const written = await readFile(path.join(session.dir, "audio", "0001.wav"));
    expect(written.toString()).toBe("fake wav");
  });

  it("skips writing audio when keepAudio is false", async () => {
    const config = await testConfig({ SCRIBE_KEEP_AUDIO: "false" });
    const session = await Session.create(config, okDeps());
    await session.ingestChunk(chunk(1));
    await expect(
      readFile(path.join(session.dir, "audio", "0001.wav")),
    ).rejects.toThrow();
  });

  it("does not run a running summary before the interval has elapsed", async () => {
    const deps = okDeps();
    const session = await Session.create(await testConfig(), deps);
    await session.ingestChunk(chunk(1));
    expect(deps.running).not.toHaveBeenCalled();
  });

  it("runs a running summary once the interval has elapsed", async () => {
    const deps = okDeps();
    let clock = 0;
    const session = await Session.create(await testConfig(), {
      ...deps,
      now: () => clock,
    });

    await session.ingestChunk(chunk(1));
    clock = 6 * 60 * 1000;
    await session.ingestChunk(chunk(2));

    expect(deps.running).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous summary and keeps recording when a summary fails", async () => {
    const deps = okDeps();
    deps.running.mockRejectedValue(new Error("claude down"));
    let clock = 0;
    const session = await Session.create(await testConfig(), {
      ...deps,
      now: () => clock,
    });

    await session.ingestChunk(chunk(1));
    clock = 6 * 60 * 1000;
    await expect(session.ingestChunk(chunk(2))).resolves.toBeUndefined();

    const markdown = await readFile(path.join(session.dir, "transcript.md"), "utf8");
    expect(markdown).toContain("hello world");
  });

  it("writes summary.md and meta.json on stop", async () => {
    const session = await Session.create(await testConfig(), okDeps());
    await session.ingestChunk(chunk(1));
    const markdown = await session.stop();

    expect(markdown).toBe("# Notes");
    expect(await readFile(path.join(session.dir, "summary.md"), "utf8")).toContain("# Notes");

    const meta = JSON.parse(await readFile(path.join(session.dir, "meta.json"), "utf8"));
    expect(meta.audioSeconds).toBeCloseTo(20, 1);
    expect(meta.runningModel).toBe("claude-opus-5");
  });

  it("never puts the audio buffer into a published transcript line", async () => {
    // Spreading the chunk input into Transcript.record would ship ~640KB of
    // WAV to the browser inside every SSE frame.
    const session = await Session.create(await testConfig(), okDeps());
    const seen: ScribeEvent[] = [];
    session.events.subscribe((e) => seen.push(e));

    await session.ingestChunk(chunk(1));

    const event = seen.find((e) => e.type === "transcript")!;
    expect(Object.keys(event.type === "transcript" ? event.line : {})).toEqual(
      ["index", "startMs", "endMs", "text", "failed"],
    );
  });

  it("never writes an API key into meta.json", async () => {
    const session = await Session.create(await testConfig(), okDeps());
    await session.ingestChunk(chunk(1));
    await session.stop();
    const meta = await readFile(path.join(session.dir, "meta.json"), "utf8");
    expect(meta).not.toContain("gsk_test");
    expect(meta).not.toContain("sk-ant-test");
  });

  it("writes the running summary to disk so a failed final summary still has something to show", async () => {
    const { session, dir } = await makeSession({
      running: vi.fn().mockResolvedValue({
        topics: ["Raft"], keyPoints: [], definitions: [], flagged: [], openQuestions: [],
      }),
      final: vi.fn().mockRejectedValue(new Error("overloaded")),
    });

    await session.ingestChunk({ index: 1, startMs: 0, endMs: 20_000, audio: Buffer.from("wav") });
    await session.stop();

    const saved = JSON.parse(await readFile(path.join(dir, "running-summary.json"), "utf8"));
    expect(saved.topics).toEqual(["Raft"]);
  });

  it("reports that it is recording until stop resolves", async () => {
    const { session } = await makeSession();
    expect(session.isRecording).toBe(true);
    await session.stop();
    expect(session.isRecording).toBe(false);
  });

  it("resolves a flag to the chunk recording at that timestamp and persists it", async () => {
    const session = await Session.create(await testConfig(), okDeps());
    await session.ingestChunk(chunk(1));
    const flag = session.flag(12_000);
    expect(flag).toEqual({ atMs: 12_000, chunkIndex: 1 });

    // flag() persists fire-and-forget (`void this.persist()`), so give the
    // write a tick to land before reading it back.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const saved = JSON.parse(
      await readFile(path.join(session.dir, "transcript.json"), "utf8"),
    );
    expect(saved.flags).toEqual([{ atMs: 12_000, chunkIndex: 1 }]);
  });

  it("leaves chunkIndex null for a flag with no line covering that timestamp yet", async () => {
    const session = await Session.create(await testConfig(), okDeps());
    const flag = session.flag(5_000);
    expect(flag.chunkIndex).toBeNull();
  });

  it("backfills chunkIndex once the chunk covering an earlier flag's timestamp is transcribed", async () => {
    // The common case: a flag marks "right now", and the chunk covering that
    // moment is still being recorded, so it has no line to resolve against
    // yet. Flag first, transcribe after.
    const session = await Session.create(await testConfig(), okDeps());
    const flag = session.flag(12_000);
    expect(flag.chunkIndex).toBeNull();

    await session.ingestChunk(chunk(1));

    // flag() persists fire-and-forget, but processChunk's own persist() is
    // awaited inside ingestChunk, so no extra tick is needed here.
    const saved = JSON.parse(
      await readFile(path.join(session.dir, "transcript.json"), "utf8"),
    );
    expect(saved.flags).toEqual([{ atMs: 12_000, chunkIndex: 1 }]);
  });

  it("does not backfill a flag whose timestamp falls outside the chunk that just landed", async () => {
    const session = await Session.create(await testConfig(), okDeps());
    const flag = session.flag(25_000);
    await session.ingestChunk(chunk(1)); // covers 0-20,000ms only
    const saved = JSON.parse(
      await readFile(path.join(session.dir, "transcript.json"), "utf8"),
    );
    expect(saved.flags).toEqual([{ atMs: 25_000, chunkIndex: null }]);
    expect(flag.chunkIndex).toBeNull();
  });

  it("quotes the real transcript line rather than the placeholder once a flag backfills", async () => {
    const session = await Session.create(await testConfig(), {
      ...okDeps(),
      transcribe: vi.fn().mockResolvedValue("what the lecturer actually said"),
    });

    session.flag(12_000);
    await session.ingestChunk(chunk(1));
    await session.stop();

    const markdown = await readFile(path.join(session.dir, "summary.md"), "utf8");
    expect(markdown).toContain("## Marked in the room");
    expect(markdown).toContain("what the lecturer actually said");
    expect(markdown).not.toContain("no transcript line at this moment");
  });

  it("appends a Marked in the room section to summary.md when the session has flags", async () => {
    const session = await Session.create(await testConfig(), okDeps());
    await session.ingestChunk(chunk(1));
    session.flag(12_000);
    await session.stop();

    const markdown = await readFile(path.join(session.dir, "summary.md"), "utf8");
    expect(markdown).toContain("## Marked in the room");
    expect(markdown).toContain("**00:12**");
  });

  it("gets no Marked in the room heading at all when the session has no flags", async () => {
    const session = await Session.create(await testConfig(), okDeps());
    await session.ingestChunk(chunk(1));
    await session.stop();

    const markdown = await readFile(path.join(session.dir, "summary.md"), "utf8");
    expect(markdown).not.toContain("Marked in the room");
  });

  it("puts the glossary in front of the bias prompt and corrects drift", async () => {
    const prompts: (string | undefined)[] = [];
    const config = await testConfig();
    const session = await Session.create(config, {
      ...okDeps(),
      transcribe: async ({ prompt }) => {
        prompts.push(prompt);
        return "makes RAF tolerant";
      },
    }, ["Raft"]);

    await session.ingestChunk(chunk(1));
    await session.ingestChunk(chunk(2));

    expect(prompts[0]).toBe("Raft.");
    // The second prompt carries the corrected tail, never the drifted one.
    expect(prompts[1]).toContain("Raft");
    expect(prompts[1]).not.toContain("RAF ");
  });
});
