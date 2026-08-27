import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAudioRouter } from "../src/server/audio-routes.js";
import type { Config } from "../src/server/config.js";

let dir: string;

/** Same house pattern as tests/server.test.ts: build the app, listen on an
 *  ephemeral port, drive it with fetch, close it. No supertest dependency. */
function app() {
  const a = express();
  a.use(createAudioRouter({ config: { sessionsDir: dir } as Config }));
  const server = a.listen(0);
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, server };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "scribe-"));
  await mkdir(path.join(dir, "2026-08-27-10-00-00", "audio"), { recursive: true });
  await writeFile(path.join(dir, "2026-08-27-10-00-00", "audio", "0002.wav"), Buffer.alloc(44));
});

describe("GET /api/sessions/:id/audio/:index", () => {
  it("serves a chunk as audio/wav", async () => {
    const { base, server } = app();
    const res = await fetch(`${base}/api/sessions/2026-08-27-10-00-00/audio/2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/wav");
    server.close();
  });

  it("404s an index with no file", async () => {
    const { base, server } = app();
    const res = await fetch(`${base}/api/sessions/2026-08-27-10-00-00/audio/9`);
    expect(res.status).toBe(404);
    server.close();
  });

  it("rejects a traversing session id", async () => {
    const { base, server } = app();
    const res = await fetch(`${base}/api/sessions/..%2F..%2Fetc/audio/0`);
    expect(res.status).toBe(400);
    server.close();
  });

  it("rejects a non-integer index", async () => {
    const { base, server } = app();
    const res = await fetch(`${base}/api/sessions/2026-08-27-10-00-00/audio/0;rm`);
    expect(res.status).toBe(400);
    server.close();
  });
});

describe("GET /api/sessions/:id/audio.wav", () => {
  it("joins the chunks on the fly when there is no full.wav", async () => {
    const { base, server } = app();
    const res = await fetch(`${base}/api/sessions/2026-08-27-10-00-00/audio.wav`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/wav");
    server.close();
  });

  it("prefers full.wav when it exists", async () => {
    await writeFile(
      path.join(dir, "2026-08-27-10-00-00", "audio", "full.wav"),
      Buffer.alloc(44),
    );
    const { base, server } = app();
    const res = await fetch(`${base}/api/sessions/2026-08-27-10-00-00/audio.wav`);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(44);
    server.close();
  });

  it("404s a session with no audio directory", async () => {
    const { base, server } = app();
    const res = await fetch(`${base}/api/sessions/2026-08-27-11-00-00/audio.wav`);
    expect(res.status).toBe(404);
    server.close();
  });
});
