import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { loadConfig } from "../src/server/config.js";
import { createLibraryRouter } from "../src/server/library-routes.js";
import { createApp } from "../src/server/index.js";

const ID = "2026-08-25-12-04-38";

/** The router with a vault behind it, or (vault: false) without one, which is
 *  how every install that has never set SCRIBE_OBSIDIAN_VAULT runs. */
async function serve(vault = true) {
  const root = await mkdtemp(path.join(tmpdir(), "scribe-obsidian-routes-"));
  const dir = path.join(root, "sessions");
  const obsidianDir = path.join(root, "vault", "Scribe");
  await mkdir(dir, { recursive: true });

  const config = loadConfig({
    GROQ_API_KEY: "gsk_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    SCRIBE_SESSIONS_DIR: dir,
    ...(vault ? { SCRIBE_OBSIDIAN_VAULT: obsidianDir } : {}),
  } as NodeJS.ProcessEnv);

  const app = express();
  app.use(createLibraryRouter({ config, liveSessionId: () => null, isRecording: () => false }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, dir, obsidianDir, server };
}

async function seed(dir: string, id = ID) {
  await mkdir(path.join(dir, id), { recursive: true });
  await writeFile(path.join(dir, id, "transcript.md"), "[00:00] Hello.\n", "utf8");
  await writeFile(path.join(dir, id, "summary.md"), "# Notes\n", "utf8");
}

async function notes(root: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) found.push(entry.name);
    if (!entry.isDirectory()) continue;
    for (const child of await readdir(path.join(root, entry.name))) {
      if (child.endsWith(".md")) found.push(`${entry.name}/${child}`);
    }
  }
  return found.sort();
}

const json = (base: string, method: string, url: string, body?: unknown) =>
  fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function category(base: string, name: string): Promise<string> {
  const body = await (await json(base, "POST", "/api/categories", { name })).json();
  return body.categories.find((c: { name: string }) => c.name === name).id;
}

/** The whole app, so the stop route's own export is what runs. */
async function serveApp(vault = true) {
  const root = await mkdtemp(path.join(tmpdir(), "scribe-obsidian-app-"));
  const dir = path.join(root, "sessions");
  const obsidianDir = path.join(root, "vault", "Scribe");
  await mkdir(dir, { recursive: true });

  const config = loadConfig({
    GROQ_API_KEY: "gsk_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    SCRIBE_SESSIONS_DIR: dir,
    ...(vault ? { SCRIBE_OBSIDIAN_VAULT: obsidianDir } : {}),
  } as NodeJS.ProcessEnv);

  const server = createApp(config, {
    transcribe: vi.fn().mockResolvedValue("hello world"),
    running: vi.fn().mockResolvedValue({
      topics: [], keyPoints: [], definitions: [], flagged: [], openQuestions: [],
    }),
    final: vi.fn().mockResolvedValue("# Notes"),
  }).listen(0);
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, obsidianDir, server };
}

describe("stopping a recording", () => {
  it("writes the note without being asked", async () => {
    const { base, obsidianDir, server } = await serveApp();
    try {
      const { id } = await (await json(base, "POST", "/api/sessions")).json();
      await json(base, "POST", `/api/sessions/${id}/stop`);

      const written = await notes(obsidianDir);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/^Uncategorised\/.+\.md$/);
    } finally {
      server.close();
    }
  });

  it("still returns the summary when there is no vault to write to", async () => {
    const { base, server } = await serveApp(false);
    try {
      const { id } = await (await json(base, "POST", "/api/sessions")).json();
      const res = await json(base, "POST", `/api/sessions/${id}/stop`);
      expect((await res.json()).markdown).toBe("# Notes");
    } finally {
      server.close();
    }
  });
});

describe("POST /api/sessions/:id/export", () => {
  it("writes the note and names the file it wrote", async () => {
    const { base, dir, obsidianDir, server } = await serve();
    try {
      await seed(dir);
      const res = await json(base, "POST", `/api/sessions/${ID}/export`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.path).toBe(path.join(obsidianDir, "Uncategorised", "25 August 2026, 12-04.md"));
      // What the status line prints, so it stays short enough not to reflow
      // the topbar around it.
      expect(body.relativePath).toBe(path.join("Uncategorised", "25 August 2026, 12-04.md"));
    } finally {
      server.close();
    }
  });

  it("says so rather than failing silently when no vault is configured", async () => {
    const { base, dir, server } = await serve(false);
    try {
      await seed(dir);
      const res = await json(base, "POST", `/api/sessions/${ID}/export`);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/SCRIBE_OBSIDIAN_VAULT/);
    } finally {
      server.close();
    }
  });

  it("refuses an id that is not a session id", async () => {
    const { base, server } = await serve();
    try {
      const res = await json(base, "POST", "/api/sessions/..%2F..%2Fetc/export");
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

describe("keeping the vault in step with the drawer", () => {
  it("renames the note when the session is renamed", async () => {
    const { base, dir, obsidianDir, server } = await serve();
    try {
      await seed(dir);
      await json(base, "POST", `/api/sessions/${ID}/export`);
      await json(base, "PATCH", `/api/sessions/${ID}`, { title: "Week 3" });

      expect(await notes(obsidianDir)).toEqual(["Uncategorised/Week 3.md"]);
    } finally {
      server.close();
    }
  });

  it("moves the note when the session is refiled", async () => {
    const { base, dir, obsidianDir, server } = await serve();
    try {
      await seed(dir);
      await json(base, "POST", `/api/sessions/${ID}/export`);
      const id = await category(base, "BUSI 520");
      await json(base, "PATCH", `/api/sessions/${ID}`, { categoryId: id });

      expect(await notes(obsidianDir)).toEqual(["BUSI 520/25 August 2026, 12-04.md"]);
    } finally {
      server.close();
    }
  });

  it("moves the note when its category is renamed", async () => {
    const { base, dir, obsidianDir, server } = await serve();
    try {
      await seed(dir);
      const id = await category(base, "BUSI 520");
      await json(base, "PATCH", `/api/sessions/${ID}`, { categoryId: id });
      await json(base, "PATCH", `/api/categories/${id}`, { name: "Financial Modelling" });

      expect(await notes(obsidianDir)).toEqual([
        "Financial Modelling/25 August 2026, 12-04.md",
      ]);
    } finally {
      server.close();
    }
  });

  it("moves the note down to Uncategorised when its category is deleted", async () => {
    const { base, dir, obsidianDir, server } = await serve();
    try {
      await seed(dir);
      const id = await category(base, "BUSI 520");
      await json(base, "PATCH", `/api/sessions/${ID}`, { categoryId: id });
      await json(base, "DELETE", `/api/categories/${id}`);

      expect(await notes(obsidianDir)).toEqual(["Uncategorised/25 August 2026, 12-04.md"]);
    } finally {
      server.close();
    }
  });

  it("leaves the note in place when the session is hidden", async () => {
    const { base, dir, obsidianDir, server } = await serve();
    try {
      await seed(dir);
      await json(base, "POST", `/api/sessions/${ID}/export`);
      await json(base, "PATCH", `/api/sessions/${ID}`, { hidden: true });

      expect(await notes(obsidianDir)).toEqual(["Uncategorised/25 August 2026, 12-04.md"]);
    } finally {
      server.close();
    }
  });

  it("writes nothing anywhere when no vault is configured", async () => {
    const { base, dir, server } = await serve(false);
    const vaultThatShouldNotExist = path.join(dir, "..", "vault");
    try {
      await seed(dir);
      await json(base, "PATCH", `/api/sessions/${ID}`, { title: "Week 3" });
      expect(await notes(vaultThatShouldNotExist)).toEqual([]);
    } finally {
      server.close();
    }
  });
});
