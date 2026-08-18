import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { loadConfig } from "../src/server/config.js";
import { createLibraryRouter } from "../src/server/library-routes.js";

async function serve(liveId: string | null = null) {
  const dir = await mkdtemp(path.join(tmpdir(), "scribe-routes-"));
  const config = loadConfig({
    GROQ_API_KEY: "gsk_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    SCRIBE_SESSIONS_DIR: dir,
  } as NodeJS.ProcessEnv);

  const app = express();
  app.use(createLibraryRouter({ config, liveSessionId: () => liveId }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, dir, server };
}

async function seed(dir: string, id: string, files: Record<string, string> = {}) {
  await mkdir(path.join(dir, id), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, id, name), body, "utf8");
  }
}

describe("GET /api/library", () => {
  it("lists folders it has never seen under Uncategorised", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30");

    const body = await (await fetch(`${base}/api/library`)).json();
    expect(body.categories[0].id).toBe("uncategorised");
    expect(body.categories[0].sessions[0].title).toBe("18 August 2026, 17:03");
    expect(body.canRestore).toBe(false);
    server.close();
  });

  it("ignores non-session directories and stray files", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30");
    await mkdir(path.join(dir, ".library-backups"), { recursive: true });
    await writeFile(path.join(dir, "library.json"), "{}", "utf8");

    const body = await (await fetch(`${base}/api/library`)).json();
    const ids = body.categories.flatMap((c: { sessions: { id: string }[] }) => c.sessions.map((s) => s.id));
    expect(ids).toEqual(["2026-08-18-17-03-30"]);
    server.close();
  });

  it("reads the duration out of meta.json and marks the live session", async () => {
    const { base, dir, server } = await serve("2026-08-18-18-00-00");
    await seed(dir, "2026-08-18-17-03-30", { "meta.json": JSON.stringify({ audioSeconds: 1800 }) });
    await seed(dir, "2026-08-18-18-00-00");

    const body = await (await fetch(`${base}/api/library`)).json();
    const rows: { id: string; live: boolean; audioSeconds: number | null }[] =
      body.categories[0].sessions;
    expect(rows.find((r) => r.id === "2026-08-18-17-03-30")).toMatchObject({
      live: false, audioSeconds: 1800,
    });
    expect(rows.find((r) => r.id === "2026-08-18-18-00-00")).toMatchObject({
      live: true, audioSeconds: null,
    });
    server.close();
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns the transcript and the final summary", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30", {
      "transcript.md": "00:00 hello world\n",
      "summary.md": "# Notes\n\nSomething.\n",
      "meta.json": JSON.stringify({ audioSeconds: 60 }),
    });

    const body = await (await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).json();
    expect(body.transcript).toContain("hello world");
    expect(body.summaryMarkdown).toContain("# Notes");
    expect(body.title).toBe("18 August 2026, 17:03");
    expect(body.meta.audioSeconds).toBe(60);
    server.close();
  });

  it("falls back to the running summary when the final summary failed", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30", {
      "transcript.md": "00:00 hello\n",
      "running-summary.json": JSON.stringify({
        topics: ["Raft"], keyPoints: [], definitions: [], flagged: [], openQuestions: [],
      }),
    });

    const body = await (await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).json();
    expect(body.summaryMarkdown).toBeNull();
    expect(body.runningSummary.topics).toEqual(["Raft"]);
    server.close();
  });

  it("treats an empty summary file the same as a missing one", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30", { "transcript.md": "x", "summary.md": "   \n" });

    const body = await (await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).json();
    expect(body.summaryMarkdown).toBeNull();
    server.close();
  });

  it("400s an id outside the id shape and 404s one that does not exist", async () => {
    const { base, server } = await serve();
    expect((await fetch(`${base}/api/sessions/not-an-id`)).status).toBe(400);
    expect((await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).status).toBe(404);
    server.close();
  });
});
