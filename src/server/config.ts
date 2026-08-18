import path from "node:path";
import os from "node:os";

export interface Config {
  groqApiKey: string;
  anthropicApiKey: string;
  chunkSeconds: number;
  summaryIntervalMinutes: number;
  runningModel: string;
  finalModel: string;
  keepAudio: boolean;
  port: number;
  language: string;
  sessionsDir: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    groqApiKey: required(env, "GROQ_API_KEY"),
    anthropicApiKey: required(env, "ANTHROPIC_API_KEY"),
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
  };
}
