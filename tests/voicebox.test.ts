import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createVoiceboxClient, VoiceboxUnavailable } from "../src/server/voicebox.js";

/** Same house pattern as the route tests: a real server on an ephemeral
 *  port, driven with fetch. Voicebox's route is multipart, so the fake
 *  parses just enough of the body to prove the field names are right. */
let server: http.Server | undefined;

function fakeVoicebox(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
) {
  server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("latin1");
    req.on("data", (d) => (body += d));
    req.on("end", () => handler(req, body, res));
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

afterEach(() => {
  server?.close();
  server = undefined;
});

const wav = Buffer.from("RIFF....WAVEfmt ");

describe("createVoiceboxClient", () => {
  it("posts the chunk as `file` with the language and returns the text", async () => {
    let seen = "";
    let url = "";
    const base = fakeVoicebox((req, body, res) => {
      url = req.url ?? "";
      seen = body;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: "  hello from whisper \n", duration: 1.2 }));
    });

    const client = createVoiceboxClient({ voiceboxUrl: base, voiceboxModel: null, language: "en" });
    const text = await client.transcribe({ audio: wav, prompt: "ignored by voicebox" });

    expect(text).toBe("hello from whisper");
    expect(url).toBe("/transcribe");
    expect(seen).toContain('name="file"; filename="chunk.wav"');
    expect(seen).toContain('name="language"');
    expect(seen).toContain("RIFF....WAVEfmt");
    expect(seen).not.toContain('name="model"');
    // Voicebox has no prompt field; make sure we never invent one.
    expect(seen).not.toContain("ignored by voicebox");
  });

  it("passes SCRIBE_VOICEBOX_MODEL through as `model` when set", async () => {
    let seen = "";
    const base = fakeVoicebox((_req, body, res) => {
      seen = body;
      res.end(JSON.stringify({ text: "x" }));
    });
    const client = createVoiceboxClient({
      voiceboxUrl: base,
      voiceboxModel: "whisper-turbo",
      language: "en",
    });
    await client.transcribe({ audio: wav });
    expect(seen).toContain('name="model"');
    expect(seen).toContain("whisper-turbo");
  });

  it("throws VoiceboxUnavailable when nothing is listening", async () => {
    // Bind then close so the port is known-free.
    const probe = http.createServer().listen(0);
    const port = (probe.address() as { port: number }).port;
    await new Promise((r) => probe.close(r));

    const client = createVoiceboxClient({
      voiceboxUrl: `http://127.0.0.1:${port}`,
      voiceboxModel: null,
      language: "en",
    });
    await expect(client.transcribe({ audio: wav })).rejects.toBeInstanceOf(VoiceboxUnavailable);
    expect(await client.reachable()).toBe(false);
  });

  it("retries a 500 once, then surfaces a plain error (not Unavailable)", async () => {
    let calls = 0;
    const base = fakeVoicebox((_req, _body, res) => {
      calls += 1;
      res.statusCode = 500;
      res.end("boom");
    });
    const client = createVoiceboxClient({ voiceboxUrl: base, voiceboxModel: null, language: "en" });
    const err = await client.transcribe({ audio: wav }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(VoiceboxUnavailable);
    expect(calls).toBe(2);
  });

  it("reports reachable when /health answers 200", async () => {
    const base = fakeVoicebox((req, _body, res) => {
      res.statusCode = req.url === "/health" ? 200 : 404;
      res.end("{}");
    });
    const client = createVoiceboxClient({ voiceboxUrl: base, voiceboxModel: null, language: "en" });
    expect(await client.reachable()).toBe(true);
  });
});
