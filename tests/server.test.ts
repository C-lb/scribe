import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/index.js";
import { Session } from "../src/server/session.js";
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

  it("500s instead of crashing when session creation fails", async () => {
    // Point SCRIBE_SESSIONS_DIR at a path whose parent segment is a regular
    // file, so the recursive mkdir() inside Session.create() rejects with
    // ENOTDIR. This exercises the try/catch around the async handler rather
    // than the happy path Session.create already covers elsewhere.
    const dir = await mkdtemp(path.join(tmpdir(), "scribe-http-"));
    const blocker = path.join(dir, "not-a-directory");
    await writeFile(blocker, "x");
    const config = loadConfig({
      GROQ_API_KEY: "gsk_test",
      ANTHROPIC_API_KEY: "sk-ant-test",
      SCRIBE_SESSIONS_DIR: path.join(blocker, "sessions"),
    } as NodeJS.ProcessEnv);
    const deps = {
      transcribe: vi.fn(),
      running: vi.fn(),
      final: vi.fn(),
    };
    const server = createApp(config, deps).listen(0);
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/api/sessions`, { method: "POST" });
    expect(res.status).toBe(500);
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

  it("serves the library alongside the recording routes", async () => {
    const { base, server } = await app();
    const res = await fetch(`${base}/api/library`);
    expect(res.status).toBe(200);
    expect((await res.json()).categories).toEqual([]);
    server.close();
  });

  it("marks the session it is currently recording as live", async () => {
    const { base, server } = await app();
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();

    const before = await (await fetch(`${base}/api/library`)).json();
    expect(before.categories[0].sessions[0]).toMatchObject({ id, live: true });

    await fetch(`${base}/api/sessions/${id}/stop`, { method: "POST" });
    const after = await (await fetch(`${base}/api/library`)).json();
    expect(after.categories[0].sessions[0].live).toBe(false);
    server.close();
  });

  it("files a new session into its course and binds the course's terms into the bias prompt", async () => {
    const { base, server, deps } = await app();

    const category = await (
      await fetch(`${base}/api/categories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "BUSI 520" }),
      })
    ).json();
    const categoryId = category.categories[0].id;
    await fetch(`${base}/api/categories/${categoryId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terms: ["Raft"] }),
    });

    const created = await (
      await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId }),
      })
    ).json();

    await fetch(`${base}/api/sessions/${created.id}/chunk`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Chunk-Index": "1",
        "X-Chunk-Start-Ms": "0",
        "X-Chunk-End-Ms": "20000",
      },
      body: Buffer.from("fake wav"),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(deps.transcribe.mock.calls[0][0].prompt).toBe("Raft.");

    const library = await (await fetch(`${base}/api/library`)).json();
    expect(library.categories[0].sessions.map((s: { id: string }) => s.id)).toContain(created.id);
    server.close();
  });

  it("400s session creation for an unknown categoryId rather than recording unfiled", async () => {
    const { base, server } = await app();
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryId: "cat_nope" }),
    });
    expect(res.status).toBe(400);
    server.close();
  });

  it("records a flag against the chunk that was recording at the time", async () => {
    const { base, server } = await app();
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();

    // Wait for the chunk to actually reach the transcript before flagging it:
    // the route answers 202 before transcription runs, so posting the flag
    // right away would race the very line it is supposed to land against.
    const events = await fetch(`${base}/api/sessions/${id}/events`);
    const reader = events.body!.getReader();

    await fetch(`${base}/api/sessions/${id}/chunk`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Chunk-Index": "0",
        "X-Chunk-Start-Ms": "0",
        "X-Chunk-End-Ms": "20000",
      },
      body: Buffer.from("fake wav"),
    });

    let received = "";
    while (!received.includes('"type":"transcript"')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    await reader.cancel();

    const res = await fetch(`${base}/api/sessions/${id}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ atMs: 12_000 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).flag).toEqual({ atMs: 12_000, chunkIndex: 0 });
    server.close();
  }, 15_000);

  it("rejects a flag with no usable timestamp", async () => {
    const { base, server } = await app();
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
    const res = await fetch(`${base}/api/sessions/${id}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ atMs: "soon" }),
    });
    expect(res.status).toBe(400);
    server.close();
  });

  it("404s a flag for an unknown session instead of crashing", async () => {
    const { base, server } = await app();
    const res = await fetch(`${base}/api/sessions/nope/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ atMs: 1000 }),
    });
    expect(res.status).toBe(404);
    server.close();
  });
});

// Critical B and Important G from the whole-branch review, both of which need
// more than one session in the Map, so they build the app the way the boot
// block does rather than through POST /api/sessions.
describe("two sessions both marked live", () => {
  async function appWithTwoLiveSessions() {
    const dir = await mkdtemp(path.join(tmpdir(), "scribe-live-"));
    const config = loadConfig({
      GROQ_API_KEY: "gsk_test",
      ANTHROPIC_API_KEY: "sk-ant-test",
      SCRIBE_SESSIONS_DIR: dir,
    } as NodeJS.ProcessEnv);
    const deps = {
      transcribe: vi.fn().mockResolvedValue("hello world"),
      running: vi.fn(),
      final: vi.fn().mockResolvedValue("# Notes"),
    };

    const stale = "2026-08-27-09-00-00";
    const live = "2026-08-27-11-00-00";
    const sessions = [];
    // Newest first, which is the order restoreLiveSessions() hands back.
    for (const id of [live, stale]) {
      await mkdir(path.join(dir, id), { recursive: true });
      await writeFile(
        path.join(dir, id, "session.json"),
        JSON.stringify({
          version: 1,
          id,
          recording: true,
          audioSeconds: 0,
          failedChunks: 0,
          silenceArtefacts: 0,
          lastSummarisedIndex: 0,
          categoryId: null,
          terms: [],
        }),
        "utf8",
      );
      await writeFile(
        path.join(dir, id, "transcript.json"),
        JSON.stringify({
          version: 1,
          lines: [{ index: 0, startMs: 0, endMs: 20_000, text: "makes RAF tolerant", failed: false }],
          flags: [],
        }),
        "utf8",
      );
      sessions.push((await Session.restore(path.join(dir, id), config, deps))!);
    }

    const server = createApp(config, deps, sessions).listen(0);
    const port = (server.address() as { port: number }).port;
    return { base: `http://127.0.0.1:${port}`, server, live, stale, dir };
  }

  it("refuses a line edit on the session that is actually recording", async () => {
    const { base, server, live } = await appWithTwoLiveSessions();
    const res = await fetch(`${base}/api/sessions/${live}/lines/0`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "makes Raft tolerant" }),
    });
    // Used to be a 200 that rewrote the live session's files, because the
    // guard compared against liveSessionId(), which returned the OLDEST.
    expect(res.status).toBe(409);
    server.close();
  });

  it("reports the newest live session as the live one", async () => {
    const { base, server, live } = await appWithTwoLiveSessions();
    const body = await (await fetch(`${base}/api/library`)).json();
    const rows: { id: string; live: boolean }[] = body.categories.flatMap(
      (c: { sessions: { id: string; live: boolean }[] }) => c.sessions,
    );
    expect(rows.filter((r) => r.live).map((r) => r.id)).toEqual([live]);
    server.close();
  });
});

// Important G. Both of these routes take no body, which makes them
// CORS-simple: any page in any tab could fire them off with mode: "no-cors"
// and stop a lecture that was still recording.
describe("same-origin gate on state-changing routes", () => {
  it("refuses a cross-site stop", async () => {
    const { base, server } = await app();
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
    const res = await fetch(`${base}/api/sessions/${id}/stop`, {
      method: "POST",
      headers: { Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
    server.close();
  });

  it("refuses a cross-site request that carries only an Origin", async () => {
    const { base, server } = await app();
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
    const res = await fetch(`${base}/api/sessions/${id}/reveal`, {
      method: "POST",
      headers: { Origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    server.close();
  });

  it("allows the page's own same-origin request", async () => {
    const { base, server } = await app();
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
    const res = await fetch(`${base}/api/sessions/${id}/stop`, {
      method: "POST",
      headers: { Origin: base, "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(200);
    server.close();
  });

  it("leaves a GET alone, so the page and its audio still load", async () => {
    const { base, server } = await app();
    const res = await fetch(`${base}/api/library`, {
      headers: { Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(200);
    server.close();
  });
});
