import express from "express";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { isSessionId } from "./library.js";
import { joinWavs } from "./wav-join.js";

export interface AudioRouterDeps {
  config: Config;
}

/** `${sessionsDir}/${id}/audio`, re-checked to still sit inside the audio
 *  directory after joining. Mirrors the two-gate pattern the reveal route
 *  in library-routes.ts uses for the same reason: id validation alone would
 *  probably do, but checking the resolved path too costs nothing. */
function resolveAudioDir(sessionsDir: string, id: string): string | null {
  if (!isSessionId(id)) return null;
  const dir = path.resolve(sessionsDir, id, "audio");
  const root = path.resolve(sessionsDir, id);
  if (dir !== path.join(root, "audio") || !dir.startsWith(`${root}${path.sep}`)) return null;
  return dir;
}

function isNonNegativeInteger(raw: string): boolean {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0;
}

async function streamFile(filePath: string, res: express.Response): Promise<void> {
  res.type("audio/wav");
  const stream = createReadStream(filePath);
  stream.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (!res.headersSent) res.status(404).json({ error: "unknown chunk" });
      return;
    }
    console.error("[scribe] failed to stream audio:", error);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });
  stream.pipe(res);
}

export function createAudioRouter(deps: AudioRouterDeps): express.Router {
  const router = express.Router();
  const { sessionsDir } = deps.config;

  router.get("/api/sessions/:id/audio/:index", async (req, res) => {
    const { id, index } = req.params;
    const audioDir = resolveAudioDir(sessionsDir, id);
    if (!audioDir) return res.status(400).json({ error: "invalid session id" });
    if (!isNonNegativeInteger(index)) return res.status(400).json({ error: "invalid chunk index" });

    const name = `${String(Number(index)).padStart(4, "0")}.wav`;
    const filePath = path.join(audioDir, name);
    // Belt and braces, the same reasoning as the reveal route: the filename is
    // built from a validated integer, but the resolved path is re-checked
    // against the directory it must stay inside before anything touches disk.
    const resolved = path.resolve(filePath);
    if (resolved !== path.join(audioDir, name)) {
      return res.status(400).json({ error: "invalid chunk index" });
    }

    try {
      await stat(filePath);
    } catch {
      return res.status(404).json({ error: "unknown chunk" });
    }
    await streamFile(filePath, res);
  });

  router.get("/api/sessions/:id/audio.wav", async (req, res) => {
    const { id } = req.params;
    const audioDir = resolveAudioDir(sessionsDir, id);
    if (!audioDir) return res.status(400).json({ error: "invalid session id" });

    const fullPath = path.join(audioDir, "full.wav");
    try {
      await stat(fullPath);
      await streamFile(fullPath, res);
      return;
    } catch {
      // No full.wav (session never stopped, or predates it): fall through to
      // joining the chunks on the fly.
    }

    let names: string[];
    try {
      names = (await readdir(audioDir)).filter((n) => /^\d{4}\.wav$/.test(n)).sort();
    } catch {
      return res.status(404).json({ error: "unknown session" });
    }
    if (names.length === 0) return res.status(404).json({ error: "no audio for this session" });

    try {
      const buffers = await Promise.all(names.map((n) => readFile(path.join(audioDir, n))));
      res.type("audio/wav");
      res.send(joinWavs(buffers));
    } catch (error) {
      console.error("[scribe] failed to join session audio:", error);
      res.status(500).json({ error: "internal error" });
    }
  });

  return router;
}
