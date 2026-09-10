import path from "node:path";
import os from "node:os";

/**
 * Which speech-to-text engine transcribes chunks.
 * - "auto": local Whisper once the sidecar has loaded its model, Groq until
 *   then and whenever the sidecar is down, decided per chunk.
 * - "local": local only. No Groq key needed, no cloud fallback.
 * - "groq": cloud only, the original behaviour. The sidecar is not started.
 */
export type SttEngine = "auto" | "local" | "groq";

export interface Config {
  /** null only when sttEngine is "local": nothing else can run without it. */
  groqApiKey: string | null;
  anthropicApiKey: string;
  sttEngine: SttEngine;
  /** Loopback port the Whisper sidecar (stt/whisper_server.py) listens on. */
  localSttPort: number;
  /** Derived from localSttPort; the client only ever needs the URL. */
  localSttUrl: string;
  /** Hugging Face repo of the MLX Whisper weights the sidecar loads. */
  localSttModel: string;
  chunkSeconds: number;
  summaryIntervalMinutes: number;
  runningModel: string;
  finalModel: string;
  keepAudio: boolean;
  port: number;
  language: string;
  sessionsDir: string;
  /**
   * The folder inside an Obsidian vault that finished sessions are mirrored
   * into, one folder per category beneath it. null when SCRIBE_OBSIDIAN_VAULT
   * is unset, which turns the whole export off rather than guessing at a
   * vault: writing notes into somebody's vault uninvited is not a default.
   */
  obsidianDir: string | null;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || !value.trim()) {
    throw new Error(`${key} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value.trim();
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() !== "false" && raw !== "0";
}

function sttEngine(env: NodeJS.ProcessEnv): SttEngine {
  const raw = (env.SCRIBE_STT ?? "").trim().toLowerCase();
  if (raw === "" || raw === "auto") return "auto";
  if (raw === "local" || raw === "groq") return raw;
  throw new Error(`SCRIBE_STT must be auto, local or groq, got ${JSON.stringify(env.SCRIBE_STT)}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const engine = sttEngine(env);
  const localSttPort = num(env, "SCRIBE_LOCAL_STT_PORT", 4748);
  return {
    // "auto" still needs the key: it is the fallback while the local model
    // loads, and a lecture is the wrong time to find out there isn't one.
    groqApiKey:
      engine === "local" ? env.GROQ_API_KEY?.trim() || null : required(env, "GROQ_API_KEY"),
    anthropicApiKey: required(env, "ANTHROPIC_API_KEY"),
    sttEngine: engine,
    localSttPort,
    localSttUrl: `http://127.0.0.1:${localSttPort}`,
    localSttModel: env.SCRIBE_LOCAL_MODEL?.trim() || "mlx-community/whisper-large-v3-turbo",
    chunkSeconds: num(env, "SCRIBE_CHUNK_SECONDS", 20),
    summaryIntervalMinutes: num(env, "SCRIBE_SUMMARY_INTERVAL_MINUTES", 5),
    runningModel: env.SCRIBE_RUNNING_MODEL?.trim() || "claude-opus-5",
    finalModel: env.SCRIBE_FINAL_MODEL?.trim() || "claude-opus-5",
    keepAudio: bool(env, "SCRIBE_KEEP_AUDIO", true),
    port: num(env, "SCRIBE_PORT", 4747),
    language: env.SCRIBE_LANGUAGE?.trim() || "en",
    sessionsDir:
      env.SCRIBE_SESSIONS_DIR?.trim() ||
      path.join(os.homedir(), "scribe", "sessions"),
    // Resolved here so a relative path in .env cannot depend on the working
    // directory the server happened to start in.
    obsidianDir: env.SCRIBE_OBSIDIAN_VAULT?.trim()
      ? path.resolve(env.SCRIBE_OBSIDIAN_VAULT.trim())
      : null,
  };
}
