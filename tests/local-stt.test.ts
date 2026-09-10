import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import {
  createLocalSttClient,
  createLocalSttSidecar,
  LocalSttUnavailable,
  SIDECAR_SCRIPT,
} from "../src/server/local-stt.js";

/** Same house pattern as the route tests: a real server on an ephemeral port,
 *  driven with fetch, standing in for stt/whisper_server.py. */
let server: http.Server | undefined;

function fakeSidecar(
  handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void,
) {
  server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => handler(req, Buffer.concat(parts), res));
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

describe("createLocalSttClient", () => {
  it("posts the raw wav with language and prompt in the query, returns trimmed text", async () => {
    let seenUrl = "";
    let seenBody: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let seenType = "";
    const base = fakeSidecar((req, body, res) => {
      seenUrl = req.url ?? "";
      seenBody = body;
      seenType = req.headers["content-type"] ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: "  hello from whisper \n", duration: 1.2 }));
    });

    const client = createLocalSttClient({ localSttUrl: base, language: "en" });
    const text = await client.transcribe({ audio: wav, prompt: "Prof. Ng said" });

    expect(text).toBe("hello from whisper");
    const url = new URL(seenUrl, base);
    expect(url.pathname).toBe("/transcribe");
    expect(url.searchParams.get("language")).toBe("en");
    expect(url.searchParams.get("prompt")).toBe("Prof. Ng said");
    expect(seenType).toBe("audio/wav");
    expect(seenBody.equals(wav)).toBe(true);
  });

  it("is Unavailable when nothing listens and when the model is still loading (503)", async () => {
    const probe = http.createServer().listen(0);
    const port = (probe.address() as { port: number }).port;
    await new Promise((r) => probe.close(r));
    const down = createLocalSttClient({ localSttUrl: `http://127.0.0.1:${port}`, language: "en" });
    await expect(down.transcribe({ audio: wav })).rejects.toBeInstanceOf(LocalSttUnavailable);
    expect(await down.ready()).toBe(false);

    const base = fakeSidecar((req, _body, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") return res.end(JSON.stringify({ ready: false }));
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "model still loading" }));
    });
    const loading = createLocalSttClient({ localSttUrl: base, language: "en" });
    await expect(loading.transcribe({ audio: wav })).rejects.toBeInstanceOf(LocalSttUnavailable);
    expect(await loading.ready()).toBe(false);
  });

  it("retries a 500 once, then surfaces a plain error, not Unavailable", async () => {
    let calls = 0;
    const base = fakeSidecar((_req, _body, res) => {
      calls += 1;
      res.statusCode = 500;
      res.end("boom");
    });
    const client = createLocalSttClient({ localSttUrl: base, language: "en" });
    const err = await client.transcribe({ audio: wav }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LocalSttUnavailable);
    expect(calls).toBe(2);
  });

  it("reports ready only when /health says so", async () => {
    const base = fakeSidecar((_req, _body, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ready: true, model: "x" }));
    });
    expect(await createLocalSttClient({ localSttUrl: base, language: "en" }).ready()).toBe(true);
  });
});

describe("createLocalSttSidecar", () => {
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter & { setEncoding: () => void };
      kill: ReturnType<typeof vi.fn>;
    };
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    child.kill = vi.fn();
    return child;
  }

  it("spawns uv with the pinned package, the script, port and model", () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const sidecar = createLocalSttSidecar(
      { localSttPort: 4748, localSttModel: "mlx-community/whisper-tiny" },
      { spawn: spawn as never, log: () => {} },
    );
    sidecar.start();
    sidecar.start(); // idempotent
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe("uv");
    expect(args).toEqual([
      "run", "--quiet", "--with", "mlx-whisper==0.4.3", SIDECAR_SCRIPT,
      "--port", "4748", "--model", "mlx-community/whisper-tiny",
    ]);
    expect(sidecar.running()).toBe(true);
    sidecar.stop();
    expect(child.kill).toHaveBeenCalled();
    expect(sidecar.running()).toBe(false);
  });

  it("forwards sidecar stderr lines with a readable prefix", () => {
    const child = fakeChild();
    const log = vi.fn();
    createLocalSttSidecar(
      { localSttPort: 1, localSttModel: "m" },
      { spawn: (() => child) as never, log },
    ).start();
    child.stderr.emit("data", "[scribe-stt] ready in 3.2s\n\n");
    expect(log).toHaveBeenCalledWith("local Whisper: ready in 3.2s");
  });

  it("explains a missing uv instead of throwing, and reports an unexpected exit", () => {
    const child = fakeChild();
    const log = vi.fn();
    const sidecar = createLocalSttSidecar(
      { localSttPort: 1, localSttModel: "m" },
      { spawn: (() => child) as never, log },
    );
    sidecar.start();
    child.emit("error", Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" }));
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/needs `uv`/);
    expect(sidecar.running()).toBe(false);

    sidecar.start();
    child.emit("exit", 1, null);
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/exited \(1\)/);
  });
});
