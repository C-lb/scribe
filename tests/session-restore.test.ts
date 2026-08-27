import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Session } from "../src/server/session.js";
import type { SessionDeps } from "../src/server/session.js";
import { loadConfig } from "../src/server/config.js";

// Same fixtures as tests/session.test.ts, not reintroduced from scratch.
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

const okDeps = (): SessionDeps => ({
  transcribe: vi.fn().mockResolvedValue("hello world"),
  running: vi.fn().mockResolvedValue({
    topics: ["t"], keyPoints: [], definitions: [], flagged: [], openQuestions: [],
  }),
  final: vi.fn().mockResolvedValue("# Notes"),
});

describe("session state on disk", () => {
  it("writes session.json as the recording runs", async () => {
    const config = await testConfig();
    const deps = okDeps();
    const session = await Session.create(config, deps);
    await session.ingestChunk({ index: 0, startMs: 0, endMs: 20_000, audio: Buffer.alloc(0) });
    const state = JSON.parse(await readFile(path.join(session.dir, "session.json"), "utf8"));
    expect(state).toMatchObject({ version: 1, recording: true, id: session.id });
  });

  it("marks the session finished when it stops", async () => {
    const config = await testConfig();
    const deps = okDeps();
    const session = await Session.create(config, deps);
    await session.stop();
    const state = JSON.parse(await readFile(path.join(session.dir, "session.json"), "utf8"));
    expect(state.recording).toBe(false);
  });

  it("restores a recording that was interrupted, and accepts the next chunk", async () => {
    const config = await testConfig();
    const deps = okDeps();
    const first = await Session.create(config, deps);
    await first.ingestChunk({ index: 0, startMs: 0, endMs: 20_000, audio: Buffer.alloc(0) });

    // The process died here. Nothing calls stop().
    const restored = await Session.restore(first.dir, config, deps);
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(first.id);
    expect(restored!.isRecording).toBe(true);

    await restored!.ingestChunk({ index: 1, startMs: 20_000, endMs: 40_000, audio: Buffer.alloc(0) });
    const lines = JSON.parse(await readFile(path.join(first.dir, "transcript.json"), "utf8")).lines;
    expect(lines.map((l: { index: number }) => l.index)).toEqual([0, 1]);
  });

  it("does not restore a session that stopped cleanly", async () => {
    const config = await testConfig();
    const deps = okDeps();
    const session = await Session.create(config, deps);
    await session.stop();
    expect(await Session.restore(session.dir, config, deps)).toBeNull();
  });
});
