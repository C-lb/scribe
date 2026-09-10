import type { Config } from "./config.js";
import type { TranscribeInput } from "./groq.js";
import { VoiceboxUnavailable } from "./voicebox.js";

export interface Transcriber {
  transcribe(input: TranscribeInput): Promise<string>;
}

export interface SttDeps {
  /** null when SCRIBE_STT=voicebox and no Groq key was given. */
  groq: Transcriber | null;
  voicebox: Transcriber;
  log?: (message: string) => void;
}

/** Which engine actually transcribed the last chunk, for the start-up line
 *  and so a session can tell in hindsight what it was recorded through. */
export type SttResolved = "groq" | "voicebox";

/**
 * Picks an engine per chunk according to SCRIBE_STT.
 *
 * "auto" tries Voicebox first every time. A refused connection is the only
 * thing that sends a chunk to Groq instead: it costs nothing to find out
 * (the socket fails in microseconds when nothing is listening), and doing it
 * per chunk means opening Voicebox halfway through a lecture moves the rest
 * of it local without a restart, and quitting it moves back to Groq the same
 * way. Any other Voicebox failure propagates, because session.ts already
 * counts a failed chunk and carries on, and silently re-sending audio to the
 * cloud after the user chose local is not a decision this file should make.
 */
export function createTranscriber(config: Pick<Config, "sttEngine">, deps: SttDeps) {
  const log = deps.log ?? ((m: string) => console.info(`[scribe] ${m}`));
  let last: SttResolved | null = null;
  let announcedFallback = false;

  function requireGroq(): Transcriber {
    if (!deps.groq) {
      throw new Error("Voicebox is not running and no GROQ_API_KEY is set to fall back to");
    }
    return deps.groq;
  }

  async function transcribe(input: TranscribeInput): Promise<string> {
    switch (config.sttEngine) {
      case "groq": {
        last = "groq";
        return requireGroq().transcribe(input);
      }
      case "voicebox": {
        last = "voicebox";
        return deps.voicebox.transcribe(input);
      }
      case "auto": {
        try {
          const text = await deps.voicebox.transcribe(input);
          if (last !== "voicebox") log("transcribing locally through Voicebox");
          last = "voicebox";
          announcedFallback = false;
          return text;
        } catch (error) {
          if (!(error instanceof VoiceboxUnavailable)) throw error;
          const groq = requireGroq();
          if (!announcedFallback) {
            log("Voicebox is not running; transcribing through Groq");
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
