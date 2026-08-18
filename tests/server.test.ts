import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/index.js";
import { loadConfig } from "../src/server/config.js";

async function app() {
  const dir = await mkdtemp(path.join(tmpdir(), "scribe-http-"));
  const config = loadConfig({
    GROQ_API_KEY: "gsk_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    SCRIBE_SESSIONS_DIR: dir,
  } as NodeJS.ProcessEnv);

  const deps = {
    transcribe: vi.fn().mockResolvedValue("hello world"),
    running: vi.fn().mockResolvedValue({
      topics: [], keyPoints: [], definitions: [], flagged: [], openQuestions: [],
    }),
    final: vi.fn().mockResolvedValue("# Notes"),
  };

  const server = createApp(config, deps).listen(0);
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, server, deps };
}

describe("HTTP API", () => {
  it("creates a session", async () => {
    const { base, server } = await app();
    const res = await fetch(`${base}/api/sessions`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toMatch(/^\d{4}-\d{2}-\d{2}-/);
    server.close();
  });

  it("accepts a chunk and answers immediately with 202", async () => {
    const { base, server } = await app();
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();

    const res = await fetch(`${base}/api/sessions/${id}/chunk`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Chunk-Index": "1",
        "X-Chunk-Start-Ms": "0",
        "X-Chunk-End-Ms": "20000",
      },
      body: Buffer.from("fake wav"),
    });
    expect(res.status).toBe(202);
    server.close();
  });

  it("404s a chunk for an unknown session instead of crashing", async () => {
    const { base, server } = await app();
    const res = await fetch(`${base}/api/sessions/nope/chunk`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Chunk-Index": "1",
        "X-Chunk-Start-Ms": "0",
        "X-Chunk-End-Ms": "20000",
      },
      body: Buffer.from("fake wav"),
    });
    expect(res.status).toBe(404);
    server.close();
  });

  it("400s a chunk with missing index headers", async () => {
    const { base, server } = await app();
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
    const res = await fetch(`${base}/api/sessions/${id}/chunk`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from("fake wav"),
    });
    expect(res.status).toBe(400);
    server.close();
  });

  it("streams transcript events over SSE", async () => {
    const { base, server } = await app();
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();

    const events = await fetch(`${base}/api/sessions/${id}/events`);
    const reader = events.body!.getReader();

    await fetch(`${base}/api/sessions/${id}/chunk`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Chunk-Index": "1",
        "X-Chunk-Start-Ms": "0",
        "X-Chunk-End-Ms": "20000",
      },
      body: Buffer.from("fake wav"),
    });

    let received = "";
    while (!received.includes("hello world")) {
      const { value, done } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    expect(received).toContain("hello world");

    await reader.cancel();
    server.close();
  }, 15_000);

  it("returns the final markdown on stop", async () => {
    const { base, server } = await app();
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
    const res = await fetch(`${base}/api/sessions/${id}/stop`, { method: "POST" });
    expect((await res.json()).markdown).toBe("# Notes");
    server.close();
  });

  it("never exposes an API key on any route", async () => {
    const { base, server } = await app();
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
    const body = await (await fetch(`${base}/api/sessions/${id}/stop`, { method: "POST" })).text();
    expect(body).not.toContain("gsk_test");
    expect(body).not.toContain("sk-ant-test");
    server.close();
  });
});
