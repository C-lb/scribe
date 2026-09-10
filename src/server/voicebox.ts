import type { Config } from "./config.js";
import { RetryableError, withRetry } from "./retry.js";
import type { TranscribeInput } from "./groq.js";

/**
 * Voicebox (github.com/jamiepine/voicebox) runs Whisper locally and exposes
 * it as `POST /transcribe` on 127.0.0.1:17493 while the desktop app is open.
 * Same audio in, same `{ text }` out as Groq, so the two are interchangeable
 * from the session's point of view. Two differences worth knowing:
 *
 * - There is no bias-prompt field. The trailing-transcript prompt Groq gets
 *   is dropped here; the course term list still applies, because session.ts
 *   corrects the text after it comes back rather than relying on the prompt.
 * - Nothing leaves the machine, and there is no per-hour charge.
 */

/** Thrown when Voicebox is not listening at all, as opposed to answering
 *  with an error. The engine chooser treats only this as "fall back to Groq":
 *  a 500 from a running Voicebox is a Voicebox problem worth retrying, but a
 *  refused connection means the app is simply not open. */
export class VoiceboxUnavailable extends Error {
  constructor(url: string, cause: unknown) {
    super(`Voicebox is not reachable at ${url}`, { cause });
    this.name = "VoiceboxUnavailable";
  }
}

export function createVoiceboxClient(
  config: Pick<Config, "voiceboxUrl" | "voiceboxModel" | "language">,
) {
  const endpoint = `${config.voiceboxUrl}/transcribe`;

  async function once(input: TranscribeInput): Promise<string> {
    const form = new FormData();
    form.append(
      "file",
      new Blob(
        [
          // See groq.ts for why offset/length are not optional here.
          new Uint8Array(
            input.audio.buffer as ArrayBuffer,
            input.audio.byteOffset,
            input.audio.byteLength,
          ),
        ],
        { type: "audio/wav" },
      ),
      "chunk.wav",
    );
    form.append("language", config.language);
    if (config.voiceboxModel) form.append("model", config.voiceboxModel);

    let response: Response;
    try {
      response = await fetch(endpoint, { method: "POST", body: form });
    } catch (error) {
      throw new VoiceboxUnavailable(config.voiceboxUrl, error);
    }

    if (response.status === 429 || response.status >= 500) {
      throw new RetryableError(`Voicebox responded ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`Voicebox rejected the request with ${response.status}`);
    }

    const body = (await response.json()) as { text?: string };
    return (body.text ?? "").trim();
  }

  return {
    async transcribe(input: TranscribeInput): Promise<string> {
      // Fewer attempts than Groq: a local failure is not a transient network
      // blip, and every retry holds the chunk queue for the whole lecture.
      return withRetry(() => once(input), { attempts: 2, baseDelayMs: 500 });
    },

    /** True when something answers on the Voicebox port. Used once at start-up
     *  for the log line; the per-chunk decision is made by the chooser. */
    async reachable(): Promise<boolean> {
      try {
        const res = await fetch(`${config.voiceboxUrl}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
