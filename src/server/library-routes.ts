import express from "express";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import {
  isSessionId,
  defaultTitle,
  readLibrary,
  writeLibrary,
  mergeLibrary,
  hasRollback,
  setEntry,
  createCategory,
  updateCategory,
  deleteCategory,
  applyOrder,
  newCategoryId,
  restoreLibrary,
  type SessionFolder,
  type LibraryFile,
  type OrderPayload,
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

  router.use(express.json({ limit: "256kb" }));

  const stamp = deps.now ?? (() => new Date().toISOString().replace(/[:.]/g, "-"));

  /** Every write answers with the whole re-rendered library, so the browser
   *  never has to reconstruct what the server just decided. */
  async function respondWithLibrary(res: express.Response): Promise<void> {
    const ids = await listFolders(sessionsDir);
    const file = await readLibrary(sessionsDir);
    const view = mergeLibrary(file, await describeFolders(sessionsDir, ids), deps.liveSessionId());
    res.json({ ...view, canRestore: await hasRollback(sessionsDir) });
  }

  /** A rejected mutation is the user's mistake, not a server fault: 400 with
   *  the reason, which the browser puts straight into the status line. */
  async function mutate(
    res: express.Response,
    change: (file: LibraryFile) => LibraryFile | Promise<LibraryFile>,
  ): Promise<void> {
    try {
      const ids = await listFolders(sessionsDir);
      const next = await change(await readLibrary(sessionsDir));
      await writeLibrary(sessionsDir, next, ids);
      await respondWithLibrary(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "bad request";
      console.error("[scribe] library write rejected:", error);
      res.status(400).json({ error: message });
    }
  }

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

  router.patch("/api/sessions/:id", async (req, res) => {
    const { id } = req.params;
    if (!isSessionId(id)) return res.status(400).json({ error: "invalid session id" });

    const patch: { title?: string | null; categoryId?: string | null } = {};
    if ("title" in req.body) patch.title = req.body.title === null ? null : String(req.body.title);
    if ("categoryId" in req.body) {
      patch.categoryId = req.body.categoryId === null ? null : String(req.body.categoryId);
    }
    await mutate(res, (file) => setEntry(file, id, patch));
  });

  router.post("/api/categories", async (req, res) => {
    await mutate(res, (file) => createCategory(file, String(req.body?.name ?? ""), newCategoryId()));
  });

  router.patch("/api/categories/:id", async (req, res) => {
    const patch: { name?: string; order?: number } = {};
    if ("name" in req.body) patch.name = String(req.body.name);
    if ("order" in req.body) patch.order = Number(req.body.order);
    await mutate(res, (file) => updateCategory(file, req.params.id, patch));
  });

  router.delete("/api/categories/:id", async (req, res) => {
    await mutate(res, (file) => deleteCategory(file, req.params.id));
  });

  router.put("/api/library/order", async (req, res) => {
    const groups = req.body?.groups;
    if (!Array.isArray(groups)) return res.status(400).json({ error: "groups must be an array" });
    for (const group of groups) {
      if (!group || !Array.isArray(group.sessionIds)) {
        return res.status(400).json({ error: "each group needs sessionIds" });
      }
    }
    const payload: OrderPayload = {
      groups: groups.map((g) => ({
        categoryId: g.categoryId == null ? null : String(g.categoryId),
        sessionIds: g.sessionIds.map(String),
      })),
    };
    await mutate(res, (file) => applyOrder(file, payload));
  });

  router.post("/api/library/restore", async (_req, res) => {
    try {
      const restored = await restoreLibrary(sessionsDir, stamp());
      if (!restored) return res.status(409).json({ error: "there is nothing to restore to" });
      await respondWithLibrary(res);
    } catch (error) {
      console.error("[scribe] restore failed:", error);
      res.status(500).json({ error: "internal error" });
    }
  });

  return router;
}
