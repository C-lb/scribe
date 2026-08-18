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
});
