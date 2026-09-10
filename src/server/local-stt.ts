import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { TranscribeInput } from "./groq.js";
import { RetryableError, withRetry } from "./retry.js";

/**
 * Local Whisper. Two halves:
 *
 * - `createLocalSttClient` talks to `stt/whisper_server.py` over HTTP on
 *   127.0.0.1. Same `{ audio, prompt } -> text` shape as the Groq client, so
 *   session.ts cannot tell them apart, and unlike Voicebox's route the prompt
 *   survives: it becomes Whisper's initial_prompt.
 * - `createLocalSttSidecar` starts and stops that Python process. Scribe owns
 *   it, so there is no separate app to open before a lecture.
 */

/** The sidecar is not answering, or is answering "still loading". Either way
 *  this chunk cannot go local right now; the chooser sends it to Groq. Any
 *  other error from a running sidecar propagates instead. */
export class LocalSttUnavailable extends Error {
  constructor(reason: string, cause?: unknown) {
    super(`local Whisper is unavailable: ${reason}`, { cause });
    this.name = "LocalSttUnavailable";
  }
}

export function createLocalSttClient(config: Pick<Config, "localSttUrl" | "language">) {
  async function once(input: TranscribeInput): Promise<string> {
    const url = new URL("/transcribe", config.localSttUrl);
    url.searchParams.set("language", config.language);
    if (input.prompt) url.searchParams.set("prompt", input.prompt);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: new Uint8Array(input.audio.buffer as ArrayBuffer, input.audio.byteOffset, input.audio.byteLength),
      });
    } catch (error) {
      throw new LocalSttUnavailable("not running", error);
    }

    if (response.status === 503) throw new LocalSttUnavailable("model still loading");
    if (response.status >= 500) throw new RetryableError(`local Whisper responded ${response.status}`);
    if (!response.ok) throw new Error(`local Whisper rejected the request with ${response.status}`);

    const body = (await response.json()) as { text?: string };
    return (body.text ?? "").trim();
  }

  return {
    async transcribe(input: TranscribeInput): Promise<string> {
      // One retry only: a local failure is not a network blip, and every
      // attempt holds the chunk queue for the rest of the lecture.
      return withRetry(() => once(input), { attempts: 2, baseDelayMs: 500 });
    },

    /** True once the sidecar has loaded its model. */
    async ready(): Promise<boolean> {
      try {
        const res = await fetch(new URL("/health", config.localSttUrl), {
          signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { ready?: boolean };
        return body.ready === true;
      } catch {
        return false;
      }
    },
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** src/server -> repo root -> stt/whisper_server.py */
export const SIDECAR_SCRIPT = path.resolve(HERE, "..", "..", "stt", "whisper_server.py");

/** Pinned so a fresh `uv run` on another day resolves the same package. */
const MLX_WHISPER = "mlx-whisper==0.4.3";

export interface SidecarDeps {
  spawn?: typeof spawn;
  log?: (message: string) => void;
}

/**
 * Runs `uv run --with mlx-whisper stt/whisper_server.py` as a child of the
 * Scribe server and forwards its stderr to the console. uv resolves the
 * environment on first run (about a minute) and caches it after that; the
 * model itself is a separate first-run download that the sidecar reports.
 *
 * Nothing here waits for readiness. The chooser treats "still loading" like
 * "not running", so early chunks go to Groq and later ones come home once the
 * sidecar says it is ready.
 */
export function createLocalSttSidecar(
  config: Pick<Config, "localSttPort" | "localSttModel">,
  deps: SidecarDeps = {},
) {
  const log = deps.log ?? ((m: string) => console.info(`[scribe] ${m}`));
  const doSpawn = deps.spawn ?? spawn;
  let child: ChildProcess | null = null;
  let stopping = false;

  function start(): void {
    if (child) return;
    child = doSpawn(
      "uv",
      [
        "run",
        "--quiet",
        "--with",
        MLX_WHISPER,
        SIDECAR_SCRIPT,
        "--port",
        String(config.localSttPort),
        "--model",
        config.localSttModel,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        // The Hugging Face download progress bar is a carriage-return
        // animation; forwarded line by line it is noise. The sidecar logs
        // "loading" and "ready" itself.
        env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: "1" },
      },
    );

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) log(line.replace(/^\[scribe-stt\] /, "local Whisper: "));
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      child = null;
      if (error.code === "ENOENT") {
        log("local Whisper needs `uv` (https://docs.astral.sh/uv/); not found, so chunks go to Groq");
      } else {
        log(`local Whisper could not start: ${error.message}`);
      }
    });

    child.on("exit", (code, signal) => {
      child = null;
      if (!stopping) log(`local Whisper exited (${signal ?? code}); chunks go to Groq until Scribe restarts`);
    });
  }

  function stop(): void {
    stopping = true;
    child?.kill();
    child = null;
  }

  // Belt and braces with the sidecar's own parent watchdog: whatever path
  // this process leaves by, the child gets a SIGTERM on the way out.
  process.once("exit", stop);

  return { start, stop, running: () => child !== null };
}
