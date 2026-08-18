import type { Config } from "./config.js";
import { RetryableError, withRetry } from "./retry.js";

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3-turbo";

export interface TranscribeInput {
  audio: Buffer;
  /** Trailing transcript text, used to keep proper nouns stable across chunks. */
  prompt?: string;
}

export function createGroqClient(config: Config) {
  async function once(input: TranscribeInput): Promise<string> {
    const form = new FormData();
    form.append(
      "file",
      new Blob(
        [
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
    form.append("model", MODEL);
    form.append("response_format", "json");
    form.append("temperature", "0");
    form.append("language", config.language);
    if (input.prompt) form.append("prompt", input.prompt);

    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.groqApiKey}` },
      body: form,
    });

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = response.headers.get("retry-after");
      throw new RetryableError(
        `Groq responded ${response.status}`,
        retryAfter ? Number(retryAfter) * 1000 : undefined,
      );
    }
    if (!response.ok) {
      // Deliberately not including the response body: it can echo request
      // headers, and the Authorization header carries the key.
      throw new Error(`Groq rejected the request with ${response.status}`);
    }

    const body = (await response.json()) as { text?: string };
    return (body.text ?? "").trim();
  }

  return {
    async transcribe(input: TranscribeInput): Promise<string> {
      return withRetry(() => once(input), { attempts: 3, baseDelayMs: 1000 });
    },
  };
}
