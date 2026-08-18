import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { Session, type SessionDeps } from "./session.js";
import { createGroqClient } from "./groq.js";
import { createSummariser } from "./claude.js";

// __dirname does not exist in ES modules.
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..", "web");

export function createApp(config: Config, deps: SessionDeps): express.Express {
  const app = express();
  const sessions = new Map<string, Session>();

  app.post("/api/sessions", async (_req, res) => {
    try {
      const session = await Session.create(config, deps);
      sessions.set(session.id, session);
      res.json({ id: session.id });
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

  createApp(config, deps).listen(config.port, () => {
    console.log(`[scribe] listening on http://localhost:${config.port}`);
  });
}
