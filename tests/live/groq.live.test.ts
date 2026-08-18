import { describe, it, expect } from "vitest";
import "dotenv/config";
import { loadConfig } from "../../src/server/config.js";
import { createGroqClient } from "../../src/server/groq.js";
import { encodeWav } from "../../src/web/audio/wav.js";

const live = process.env.SCRIBE_LIVE_TESTS === "1";

describe.skipIf(!live)("Groq transcription (live)", () => {
  it("accepts a generated WAV and returns a string", async () => {
    // Two seconds of silence. We are asserting the request shape is accepted,
    // not that Whisper hallucinates words out of nothing.
    const samples = new Float32Array(16000 * 2);
    const wav = Buffer.from(encodeWav(samples, 16000));

    const client = createGroqClient(loadConfig());
    const text = await client.transcribe({ audio: wav });
    expect(typeof text).toBe("string");
  }, 30_000);
});
