import type { Config } from "./config.js";
import type { TranscribeInput } from "./groq.js";
import { LocalSttUnavailable } from "./local-stt.js";

export interface Transcriber {
  transcribe(input: TranscribeInput): Promise<string>;
}

export interface SttDeps {
  /** null when SCRIBE_STT=local and no Groq key was given. */
  groq: Transcriber | null;
  local: Transcriber;
  log?: (message: string) => void;
}

/** Which engine actually transcribed the last chunk. */
export type SttResolved = "groq" | "local";

/**
 * Picks an engine per chunk according to SCRIBE_STT.
 *
 * "auto" tries local Whisper first every time. Only "unavailable" (sidecar
 * not running, or still loading its model) sends the chunk to Groq: the check
 * costs microseconds, and doing it per chunk means the first minute of a
 * lecture goes to the cloud while the model loads and the rest comes home
 * without a restart. Any other local failure propagates, because session.ts
 * already counts a failed chunk and carries on, and quietly re-sending audio
 * to the cloud after a real local error is not this file's call to make.
 */
export function createTranscriber(config: Pick<Config, "sttEngine">, deps: SttDeps) {
  const log = deps.log ?? ((m: string) => console.info(`[scribe] ${m}`));
  let last: SttResolved | null = null;
  let announcedFallback = false;

  function requireGroq(): Transcriber {
    if (!deps.groq) {
      throw new Error("local Whisper is unavailable and no GROQ_API_KEY is set to fall back to");
    }
    return deps.groq;
  }

  async function transcribe(input: TranscribeInput): Promise<string> {
    switch (config.sttEngine) {
      case "groq": {
        last = "groq";
        return requireGroq().transcribe(input);
      }
      case "local": {
        last = "local";
        return deps.local.transcribe(input);
      }
      case "auto": {
        try {
          const text = await deps.local.transcribe(input);
          if (last !== "local") log("transcribing locally");
          last = "local";
          announcedFallback = false;
          return text;
        } catch (error) {
          if (!(error instanceof LocalSttUnavailable)) throw error;
          const groq = requireGroq();
          if (!announcedFallback) {
            log(`${error.message}; transcribing through Groq`);
            announcedFallback = true;
          }
          last = "groq";
          return groq.transcribe(input);
        }
      }
    }
  }

  return {
    transcribe,
    /** Engine that handled the most recent chunk, or null before the first. */
    lastEngine: (): SttResolved | null => last,
  };
}
