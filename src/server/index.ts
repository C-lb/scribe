import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { Session, type SessionDeps } from "./session.js";
import { createGroqClient } from "./groq.js";
import { createSummariser } from "./claude.js";
import { createLibraryRouter } from "./library-routes.js";
import { createAudioRouter } from "./audio-routes.js";
import { snapshotLibrary, defaultTitle, readLibrary, writeLibrary, setEntry } from "./library.js";

// __dirname does not exist in ES modules.
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..", "web");

export function createApp(config: Config, deps: SessionDeps): express.Express {
  const app = express();
  const sessions = new Map<string, Session>();

  app.post("/api/sessions", express.json(), async (req, res) => {
    try {
      // categoryId is optional: recording with no course picked stays exactly
      // as it was before this task, an unfiled session with an empty term list.
      const rawCategoryId = req.body?.categoryId;
      let categoryId: string | undefined;
      let terms: string[] = [];
      if (rawCategoryId !== undefined && rawCategoryId !== null) {
        categoryId = String(rawCategoryId);
        const file = await readLibrary(config.sessionsDir);
        const category = file.categories.find((c) => c.id === categoryId);
        // An unknown categoryId is the caller's mistake (a stale drawer, a
        // deleted category raced against a start-recording click), not a
        // reason to silently record without the terms the user thinks are
        // bound in.
        if (!category) return res.status(400).json({ error: "unknown category" });
        terms = category.terms ?? [];
      }

      const session = await Session.create(config, deps, terms);
      sessions.set(session.id, session);

      if (categoryId) {
        // Filed straight away so the drawer shows it under its course from
        // the first render, rather than in Uncategorised until the user
        // happens to move it. Best-effort: a library write failure here must
        // not fail session creation, since the recording itself already
        // exists and losing the filing is recoverable by hand later.
        try {
          const file = await readLibrary(config.sessionsDir);
          const next = setEntry(file, session.id, { categoryId });
          // Every key already in next.entries is passed as "known", so this
          // write only adds the new entry and never prunes an existing one --
          // pruning belongs to the routes in library-routes.ts, which have
          // the full folder listing this handler does not.
          await writeLibrary(config.sessionsDir, next, Object.keys(next.entries));
        } catch (error) {
          console.error(`[scribe] failed to file session ${session.id} into its category:`, error);
        }
      }

      // The title goes back with the id so the browser never has to invent a
      // name for the recording it just started: the export filename mid-record
      // then matches the one the drawer gives the same session afterwards.
      // hasAudio reflects config.keepAudio rather than a disk check: no chunk
      // has been written yet, but whether one ever will is already decided.
      res.json({ id: session.id, title: defaultTitle(session.id), hasAudio: config.keepAudio });
    } catch (error) {
      console.error("[scribe] failed to create session:", error);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.post(
    "/api/sessions/:id/chunk",
    express.raw({ type: "audio/wav", limit: "25mb" }),
    (req, res) => {
      const session = sessions.get(req.params.id);
      if (!session) return res.status(404).json({ error: "unknown session" });

      const index = Number(req.get("X-Chunk-Index"));
      const startMs = Number(req.get("X-Chunk-Start-Ms"));
      const endMs = Number(req.get("X-Chunk-End-Ms"));
      if (![index, startMs, endMs].every(Number.isFinite)) {
        return res.status(400).json({ error: "missing or invalid chunk headers" });
      }

      // Answer before transcribing. The browser's upload queue must never wait
      // on Groq — results come back over SSE.
      res.status(202).json({});
      void session.ingestChunk({ index, startMs, endMs, audio: req.body as Buffer });
    },
  );

  app.post("/api/sessions/:id/flag", express.json(), (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "unknown session" });

    // Same shape of guard as the chunk headers above: a flag with no usable
    // timestamp is the caller's mistake, not something to record as zero.
    const atMs = req.body?.atMs;
    if (!(Number.isFinite(atMs) && atMs >= 0)) {
      return res.status(400).json({ error: "missing or invalid atMs" });
    }

    const flag = session.flag(atMs);
    res.json({ flag });
  });

  app.get("/api/sessions/:id/events", (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "unknown session" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // writeHead() only queues the headers; Node doesn't put them on the wire
    // until the first body write. Without this, a subscriber with no history
    // and no immediate event sees its request hang until the next heartbeat.
    res.flushHeaders();

    const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    session.events.replay(send);
    const unsubscribe = session.events.subscribe(send);

    // Proxies and browsers drop an idle stream; a comment line keeps it warm.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post("/api/sessions/:id/stop", async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "unknown session" });
    try {
      const markdown = await session.stop();
      res.json({ markdown });
    } catch (error) {
      console.error(`[scribe] failed to stop session ${req.params.id}:`, error);
      res.status(500).json({ error: "internal error" });
    }
  });

  // Only one recording runs at a time in practice; take the most recent one
  // still marked as recording so the list can flag the live row.
  const liveSessionId = () => {
    for (const [id, session] of [...sessions].reverse()) {
      if (session.isRecording) return id;
    }
    return null;
  };

  app.use(createLibraryRouter({ config, liveSessionId }));
  app.use(createAudioRouter({ config }));

  app.use(express.static(webRoot));
  return app;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  // Express 4 does not catch rejections thrown by async route handlers, so an
  // uncaught one would otherwise crash the process and take down every
  // in-progress recording at once. Staying alive can mask a bug that a crash
  // would have surfaced loudly, but for a lecture recorder a live process
  // with one broken request beats a dead process that loses the recording —
  // so we log and keep going rather than let Node's default behaviour kill us.
  process.on("unhandledRejection", (reason) => {
    console.error("[scribe] unhandled rejection:", reason);
  });

  const config = loadConfig();
  const groq = createGroqClient(config);
  const summariser = createSummariser(config);

  const deps: SessionDeps = {
    transcribe: (input) => groq.transcribe(input),
    running: (transcript, previous) => summariser.running(transcript, previous),
    final: (transcript) => summariser.final(transcript),
  };

  void (async () => {
    // The restore point is the library as it was when Scribe was opened.
    // Taken before the first request is served, so nothing can change
    // underneath it. A failure here (permissions, full disk) must not stop
    // the recorder from starting — a missing backup is recoverable, a lost
    // recording is not.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await snapshotLibrary(config.sessionsDir, stamp);
    } catch (error) {
      console.error(
        "[scribe] could not take a library restore point; starting recorder without one:",
        error,
      );
    }

    // Loopback only, deliberately. This server has no authentication, reads and
    // writes a directory of the user's lecture recordings, and has one route
    // that asks the OS to open a folder. Express's default binds every
    // interface, which on a café network hands all of that to whoever else is
    // on the wifi. Nothing here is meant to leave the machine.
    createApp(config, deps).listen(config.port, "127.0.0.1", () => {
      console.log(`[scribe] listening on http://localhost:${config.port}`);
    });
  })();
}
