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

const json = (base: string, method: string, url: string, body?: unknown) =>
  fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("library writes", () => {
  it("renames a session and returns the re-rendered library", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");

      const res = await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "Raft" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.categories[0].sessions[0].title).toBe("Raft");
      expect(body.categories[0].sessions[0].named).toBe(true);
    } finally {
      server.close();
    }
  });

  it("clearing a title reverts the row to its date", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");
      await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "Raft" });

      const body = await (await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "" })).json();
      expect(body.categories[0].sessions[0].title).toBe("18 August 2026, 17:03");
    } finally {
      server.close();
    }
  });

  it("creates, renames, and deletes a category without touching the recording", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");

      const created = await (await json(base, "POST", "/api/categories", { name: "BUSI 520" })).json();
      const id = created.categories[0].id;
      expect(created.categories[0].name).toBe("BUSI 520");

      await json(base, "PATCH", `/api/sessions/2026-08-18-17-03-30`, { categoryId: id });
      const renamed = await (await json(base, "PATCH", `/api/categories/${id}`, { name: "Distributed" })).json();
      expect(renamed.categories[0].name).toBe("Distributed");

      const deleted = await (await json(base, "DELETE", `/api/categories/${id}`)).json();
      expect(deleted.categories[0].id).toBe("uncategorised");
      expect(deleted.categories[0].sessions[0].id).toBe("2026-08-18-17-03-30");
    } finally {
      server.close();
    }
  });

  it("400s an unknown category rather than half-applying it", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");
      const res = await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { categoryId: "cat_nope" });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("applies a whole drag as one payload", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");
      await seed(dir, "2026-08-17-17-03-30");
      const created = await (await json(base, "POST", "/api/categories", { name: "BUSI 520" })).json();
      const id = created.categories[0].id;

      const body = await (
        await json(base, "PUT", "/api/library/order", {
          groups: [
            { categoryId: id, sessionIds: ["2026-08-17-17-03-30", "2026-08-18-17-03-30"] },
          ],
        })
      ).json();

      expect(body.categories[0].sessions.map((s: { id: string }) => s.id)).toEqual([
        "2026-08-17-17-03-30",
        "2026-08-18-17-03-30",
      ]);
    } finally {
      server.close();
    }
  });

  it("400s a malformed order payload", async () => {
    const { base, server } = await serve();
    try {
      expect((await json(base, "PUT", "/api/library/order", { groups: "nope" })).status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("restores the library to the snapshot taken at start", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");
      await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "before" });

      const { snapshotLibrary } = await import("../src/server/library.js");
      await snapshotLibrary(dir, "stamp-open");

      await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "after" });
      const body = await (await json(base, "POST", "/api/library/restore")).json();
      expect(body.categories[0].sessions[0].title).toBe("before");
    } finally {
      server.close();
    }
  });

  it("409s a restore when no snapshot exists", async () => {
    const { base, server } = await serve();
    try {
      expect((await json(base, "POST", "/api/library/restore")).status).toBe(409);
    } finally {
      server.close();
    }
  });

  it("500s a genuine write failure instead of reporting it as a 400", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");
      // Make the persistence phase fail: library.json is a directory, so
      // writeLibrary's rename-over-target cannot succeed.
      await mkdir(path.join(dir, "library.json"), { recursive: true });

      const res = await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "Raft" });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("internal error");
      expect(JSON.stringify(body)).not.toMatch(/ENOTDIR|EISDIR|ENOENT|rename|library\.json\.tmp/);
    } finally {
      server.close();
    }
  });

  it("400s a non-numeric category order before it reaches updateCategory", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");
      const created = await (await json(base, "POST", "/api/categories", { name: "BUSI 520" })).json();
      const id = created.categories[0].id;

      const res = await json(base, "PATCH", `/api/categories/${id}`, { order: "not-a-number" });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
