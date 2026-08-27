import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Session } from "../src/server/session.js";
import { createApp } from "../src/server/index.js";
import { testConfig, okDeps } from "./fixtures.js";

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

  // Fix round 1, finding 1: a chunk (or a flag) that lands while stop() is
  // still running used to queue a persist() that could race the direct
  // writes stop() made itself, both sharing writeTranscriptFile's and
  // writeState's one fixed temp path. The straggler's persist (recording:
  // true) could win the rename after stop()'s own final write (recording:
  // false), leaving session.json reading recording: true once stop() has
  // already returned -- exactly the state restoreLiveSessions() would
  // wrongly resurrect on the next boot. Everything is chained through
  // this.queue now, so the straggler is guaranteed to finish, and its
  // persist to run, before stop()'s own final write.
  it("does not let a straggling chunk racing stop() leave session.json reading recording: true", async () => {
    const config = await testConfig();
    const deps = okDeps();
    const session = await Session.create(config, deps);

    // The vulnerable window is the gap between stop() enqueueing its own
    // persist and its final write, not before stop() is even called -- a
    // chunk already in flight when stop() starts was always safe, because
    // stop()'s first `await this.queue` already waits for it. So this calls
    // stop() first, synchronously, then enqueues the straggling chunk in the
    // very next statement, before either has had a chance to run: with the
    // fix, ingestChunk() reads `this.queue` after stop() has already chained
    // its own persist onto it, so the straggler is forced to queue behind
    // stop()'s work rather than beside it.
    const stopDone = session.stop();
    const chunkDone = session.ingestChunk({
      index: 0,
      startMs: 0,
      endMs: 20_000,
      audio: Buffer.alloc(0),
    });

    await Promise.all([stopDone, chunkDone]);

    const state = JSON.parse(await readFile(path.join(session.dir, "session.json"), "utf8"));
    expect(state.recording).toBe(false);
  });
});

describe("restoring a session into a running server", () => {
  it("accepts a chunk for a restored session instead of 404ing it", async () => {
    const config = await testConfig();
    const deps = okDeps();

    const first = await Session.create(config, deps);
    await first.ingestChunk({ index: 0, startMs: 0, endMs: 20_000, audio: Buffer.alloc(0) });

    // The process died here. Nothing calls stop(). A fresh boot would call
    // restoreLiveSessions() and seed createApp() with the result -- done
    // directly here rather than through the module's boot block, since that
    // block only runs when index.ts is executed as the entry script.
    const restored = await Session.restore(first.dir, config, deps);
    expect(restored).not.toBeNull();

    const server = createApp(config, deps, [restored!]).listen(0);
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/api/sessions/${first.id}/chunk`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Chunk-Index": "1",
        "X-Chunk-Start-Ms": "20000",
        "X-Chunk-End-Ms": "40000",
      },
      body: Buffer.from("fake wav"),
    });
    expect(res.status).toBe(202);
    server.close();
  });
});
