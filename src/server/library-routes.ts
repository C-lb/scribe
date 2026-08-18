import express from "express";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import {
  isSessionId,
  defaultTitle,
  readLibrary,
  mergeLibrary,
  hasRollback,
  type SessionFolder,
} from "./library.js";

export interface LibraryRouterDeps {
  config: Config;
  liveSessionId: () => string | null;
  now?: () => string;
}

async function listFolders(sessionsDir: string): Promise<string[]> {
  try {
    const items = await readdir(sessionsDir, { withFileTypes: true });
    return items.filter((i) => i.isDirectory() && isSessionId(i.name)).map((i) => i.name);
  } catch {
    return [];
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    const raw = await readFile(file, "utf8");
    return raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

async function describeFolders(sessionsDir: string, ids: string[]): Promise<SessionFolder[]> {
  return Promise.all(
    ids.map(async (id) => {
      const meta = await readJson<{ audioSeconds?: number }>(
        path.join(sessionsDir, id, "meta.json"),
      );
      return { id, audioSeconds: typeof meta?.audioSeconds === "number" ? meta.audioSeconds : null };
    }),
  );
}

export function createLibraryRouter(deps: LibraryRouterDeps): express.Router {
  const router = express.Router();
  const { sessionsDir } = deps.config;

  router.get("/api/library", async (_req, res) => {
    try {
      const ids = await listFolders(sessionsDir);
      const file = await readLibrary(sessionsDir);
      const view = mergeLibrary(file, await describeFolders(sessionsDir, ids), deps.liveSessionId());
      res.json({ ...view, canRestore: await hasRollback(sessionsDir) });
    } catch (error) {
      console.error("[scribe] failed to read the library:", error);
      res.status(500).json({ error: "internal error" });
    }
  });

  router.get("/api/sessions/:id", async (req, res) => {
    const { id } = req.params;
    if (!isSessionId(id)) return res.status(400).json({ error: "invalid session id" });

    const dir = path.join(sessionsDir, id);
    const transcript = await readText(path.join(dir, "transcript.md"));
    const meta = await readJson<Record<string, unknown>>(path.join(dir, "meta.json"));
    const summaryMarkdown = await readText(path.join(dir, "summary.md"));
    const runningSummary = await readJson<unknown>(path.join(dir, "running-summary.json"));

    if (transcript === null && meta === null && summaryMarkdown === null && runningSummary === null) {
      return res.status(404).json({ error: "unknown session" });
    }

    const file = await readLibrary(sessionsDir);
    const title = file.entries[id]?.title?.trim() || defaultTitle(id);
    res.json({ id, title, transcript: transcript ?? "", summaryMarkdown, runningSummary, meta });
  });

  return router;
}
