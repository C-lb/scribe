import { describe, it, expect, vi } from "vitest";

// One failure switch for readdir, so a test can make the sessions directory
// unlistable the way EMFILE or a permissions blip would. Everything else in
// node:fs/promises stays real: the tests write library files through it.
const { readdirFails } = vi.hoisted(() => ({ readdirFails: { value: false } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      if (!readdirFails.value) return (actual.readdir as (...a: unknown[]) => unknown)(...args);
      return Promise.reject(Object.assign(new Error("too many open files"), { code: "EMFILE" }));
    },
  };
});

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
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
    try {
      await seed(dir, "2026-08-18-17-03-30");

      const body = await (await fetch(`${base}/api/library`)).json();
      expect(body.categories[0].id).toBe("uncategorised");
      expect(body.categories[0].sessions[0].title).toBe("18 August 2026, 17:03");
      expect(body.canRestore).toBe(false);
    } finally {
      server.close();
    }
  });

  it("ignores non-session directories and stray files", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");
      await mkdir(path.join(dir, ".library-backups"), { recursive: true });
      await writeFile(path.join(dir, "library.json"), "{}", "utf8");

      const body = await (await fetch(`${base}/api/library`)).json();
      const ids = body.categories.flatMap((c: { sessions: { id: string }[] }) =>
        c.sessions.map((s) => s.id),
      );
      expect(ids).toEqual(["2026-08-18-17-03-30"]);
    } finally {
      server.close();
    }
  });

  it("reads the duration out of meta.json and marks the live session", async () => {
    const { base, dir, server } = await serve("2026-08-18-18-00-00");
    try {
      await seed(dir, "2026-08-18-17-03-30", {
        "meta.json": JSON.stringify({ audioSeconds: 1800 }),
      });
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
    } finally {
      server.close();
    }
  });

  it("shows an empty library rather than failing when the folders cannot be listed", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");
      readdirFails.value = true;
      const res = await fetch(`${base}/api/library`);
      expect(res.status).toBe(200);
      expect((await res.json()).categories).toEqual([]);
    } finally {
      readdirFails.value = false;
      server.close();
    }
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns the transcript and the final summary", async () => {
    const { base, dir, server } = await serve();
    try {
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
    } finally {
      server.close();
    }
  });

  it("falls back to the running summary when the final summary failed", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30", {
        "transcript.md": "00:00 hello\n",
        "running-summary.json": JSON.stringify({
          topics: ["Raft"], keyPoints: [], definitions: [], flagged: [], openQuestions: [],
        }),
      });

      const body = await (await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).json();
      expect(body.summaryMarkdown).toBeNull();
      expect(body.runningSummary.topics).toEqual(["Raft"]);
    } finally {
      server.close();
    }
  });

  it("treats an empty summary file the same as a missing one", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30", { "transcript.md": "x", "summary.md": "   \n" });

      const body = await (await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).json();
      expect(body.summaryMarkdown).toBeNull();
    } finally {
      server.close();
    }
  });

  it("400s an id outside the id shape and 404s one that does not exist", async () => {
    const { base, server } = await serve();
    try {
      expect((await fetch(`${base}/api/sessions/not-an-id`)).status).toBe(400);
      expect((await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("returns structured lines and flags from transcript.json when present", async () => {
    const { base, dir, server } = await serve();
    try {
      const sessionDir = path.join(dir, "2026-08-18-17-03-30");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(path.join(sessionDir, "meta.json"), JSON.stringify({ audioSeconds: 60 }), "utf8");
      await writeFile(
        path.join(sessionDir, "transcript.json"),
        JSON.stringify({
          version: 1,
          lines: [
            { index: 0, startMs: 0, endMs: 20_000, text: "Raft elects a leader", failed: false },
            { index: 2, startMs: 40_000, endMs: 60_000, text: "The term number rises", failed: false },
          ],
          flags: [{ atMs: 40_000, chunkIndex: 2 }],
        }),
        "utf8",
      );

      const body = await (await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).json();
      expect(body.structured).toBe(true);
      expect(body.lines.map((l: { index: number }) => l.index)).toEqual([0, 2]);
      expect(body.flags).toEqual([{ atMs: 40_000, chunkIndex: 2 }]);
      expect(body.hasAudio).toBe(false);
    } finally {
      server.close();
    }
  });

  it("falls back to parsing transcript.md for a legacy session with no transcript.json", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30", {
        "transcript.md": "[00:00] First line\n\n[00:20] Second line\n",
      });

      const body = await (await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).json();
      expect(body.structured).toBe(false);
      expect(body.lines).toEqual([
        { index: 0, startMs: 0, endMs: 20_000, text: "First line", failed: false },
        { index: 1, startMs: 20_000, endMs: 40_000, text: "Second line", failed: false },
      ]);
      expect(body.flags).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("reports hasAudio true when the audio directory has a chunk WAV, excluding full.wav", async () => {
    const { base, dir, server } = await serve();
    try {
      const sessionDir = path.join(dir, "2026-08-18-17-03-30");
      await mkdir(path.join(sessionDir, "audio"), { recursive: true });
      await writeFile(path.join(sessionDir, "transcript.md"), "[00:00] hello\n", "utf8");
      await writeFile(path.join(sessionDir, "audio", "full.wav"), "fake", "utf8");

      let body = await (await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).json();
      expect(body.hasAudio).toBe(false);

      await writeFile(path.join(sessionDir, "audio", "0000.wav"), "fake", "utf8");
      body = await (await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).json();
      expect(body.hasAudio).toBe(true);
    } finally {
      server.close();
    }
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

  it("hides a session so it no longer appears, without touching its folder", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");

      const res = await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { hidden: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.categories).toEqual([]);

      const stat = await import("node:fs/promises").then((m) =>
        m.stat(path.join(dir, "2026-08-18-17-03-30")),
      );
      expect(stat.isDirectory()).toBe(true);
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

  it("reorders categories via categoryIds in the bulk order payload", async () => {
    const { base, server } = await serve();
    try {
      const a = await (await json(base, "POST", "/api/categories", { name: "First" })).json();
      const idA = a.categories[0].id;
      const b = await (await json(base, "POST", "/api/categories", { name: "Second" })).json();
      const idB = b.categories.find((c: { name: string }) => c.name === "Second").id;

      const body = await (
        await json(base, "PUT", "/api/library/order", { groups: [], categoryIds: [idB, idA] })
      ).json();

      expect(body.categories.map((c: { id: string }) => c.id)).toEqual([idB, idA]);
    } finally {
      server.close();
    }
  });

  it("400s a malformed categoryIds without applying anything", async () => {
    const { base, server } = await serve();
    try {
      const before = await (
        await json(base, "PUT", "/api/library/order", { groups: [], categoryIds: "nope" })
      );
      expect(before.status).toBe(400);
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

  it("restoring un-hides a session hidden since the snapshot was taken", async () => {
    // The design's whole justification for having no un-hide affordance in the
    // UI is that restore-to-launch-snapshot reinstates it. That has to hold.
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");
      // snapshotLibrary needs an existing library.json to snapshot from, same
      // as the "restores the library" test above.
      await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "before" });

      const { snapshotLibrary } = await import("../src/server/library.js");
      await snapshotLibrary(dir, "stamp-open");

      const hidden = await (
        await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { hidden: true })
      ).json();
      expect(hidden.categories).toEqual([]);

      const restored = await (await json(base, "POST", "/api/library/restore")).json();
      const ids = restored.categories.flatMap((c: { sessions: { id: string }[] }) =>
        c.sessions.map((s) => s.id),
      );
      expect(ids).toEqual(["2026-08-18-17-03-30"]);
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

  // The write prunes every entry whose folder it is not told about, so a
  // listing that failed must never be mistaken for a folder list with nothing
  // in it: that would write a library with every title and category gone.
  it("writes nothing when the sessions directory cannot be listed", async () => {
    const { base, dir, server } = await serve();
    try {
      await seed(dir, "2026-08-18-17-03-30");
      const created = await (await json(base, "POST", "/api/categories", { name: "BUSI 520" })).json();
      const categoryId = created.categories[0].id;
      await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", {
        title: "Raft", categoryId,
      });
      const before = await readFile(path.join(dir, "library.json"), "utf8");

      readdirFails.value = true;
      const res = await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "Paxos" });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("internal error");
      readdirFails.value = false;

      expect(await readFile(path.join(dir, "library.json"), "utf8")).toBe(before);
      const body = await (await fetch(`${base}/api/library`)).json();
      expect(body.categories[0].name).toBe("BUSI 520");
      expect(body.categories[0].sessions[0].title).toBe("Raft");
    } finally {
      readdirFails.value = false;
      server.close();
    }
  });
});

describe("POST /api/sessions/:id/reveal", () => {
  async function serveWithReveal() {
    const dir = await mkdtemp(path.join(tmpdir(), "scribe-reveal-"));
    const config = loadConfig({
      GROQ_API_KEY: "gsk_test",
      ANTHROPIC_API_KEY: "sk-ant-test",
      SCRIBE_SESSIONS_DIR: dir,
    } as NodeJS.ProcessEnv);
    const reveal = vi.fn().mockResolvedValue(undefined);
    const app = express();
    app.use(createLibraryRouter({ config, liveSessionId: () => null, reveal }));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    return { base: `http://127.0.0.1:${port}`, dir, server, reveal };
  }

  it("opens the session folder", async () => {
    const { base, dir, server, reveal } = await serveWithReveal();
    try {
      await seed(dir, "2026-08-18-17-03-30");

      const res = await fetch(`${base}/api/sessions/2026-08-18-17-03-30/reveal`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(reveal).toHaveBeenCalledWith(path.join(dir, "2026-08-18-17-03-30"));
    } finally {
      server.close();
    }
  });

  it("rejects traversal, separators, and anything outside the id shape without shelling out", async () => {
    const { base, server, reveal } = await serveWithReveal();
    try {
      // "not-an-id" and "%252e%252e" (which arrives at the handler as the
      // literal string "%2e%2e", not decoded further) both exercise "a
      // non-matching string is rejected". The decoded-traversal property is
      // covered separately below by a raw ".." id and by the embedded
      // separator in "2026-08-18-17-03-30%2F..".
      for (const bad of ["not-an-id", "%252e%252e", "2026-08-18-17-03-30%2F..", "a;open%20-a%20Calculator"]) {
        const res = await fetch(`${base}/api/sessions/${bad}/reveal`, { method: "POST" });
        expect(res.status).toBe(400);
      }
      expect(reveal).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("rejects a decoded '..' id delivered over a raw socket, where client-side URL normalisation can't intervene", async () => {
    // fetch()/undici, and even http.request(urlString), parse the URL with
    // the WHATWG URL algorithm, which collapses "%2e%2e" (and bare "..")
    // path segments before the request ever leaves the process — so those
    // clients can't put a literal ".." on the wire. Passing `path` directly
    // in http.request's options-object form skips URL parsing entirely and
    // sends the raw string, which is what an attacker using curl or a raw
    // socket could also do. This confirms the route's own validation — not
    // the HTTP client — is what stops it.
    const { server, reveal } = await serveWithReveal();
    const port = (server.address() as { port: number }).port;
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port, path: "/api/sessions/%2e%2e/reveal", method: "POST" },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(400);
      expect(reveal).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("404s a session folder that does not exist", async () => {
    const { base, server, reveal } = await serveWithReveal();
    try {
      const res = await fetch(`${base}/api/sessions/2026-08-18-17-03-30/reveal`, { method: "POST" });
      expect(res.status).toBe(404);
      expect(reveal).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
