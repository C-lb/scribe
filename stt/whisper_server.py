"""Local Whisper for Scribe, as a tiny HTTP sidecar.

Scribe's Node server spawns this with `uv run --with mlx-whisper` and talks to
it on 127.0.0.1 only. It exists so a lecture can be transcribed without a
cloud round trip or an API key: mlx-whisper runs the model on the Mac's GPU
through Apple's MLX framework, which is the same route Voicebox takes (its
MLXSTTBackend), minus the desktop app.

Protocol, deliberately smaller than a multipart form:

  GET  /health                       -> {"ready": bool, "model": str}
  POST /transcribe?language=en&prompt=...   body: 16 kHz mono 16-bit WAV
                                     -> {"text": str, "duration": float}

A POST before the model has finished loading answers 503 so the Node side can
fall back to Groq for that chunk instead of waiting. `prompt` maps to
Whisper's initial_prompt, which is what keeps proper nouns stable across
20-second chunks; Voicebox's HTTP route drops it, this one keeps it.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"
SAMPLE_RATE = 16000

state = {"ready": False, "model": DEFAULT_MODEL, "error": None}
lock = threading.Lock()


def log(message: str) -> None:
    print(f"[scribe-stt] {message}", file=sys.stderr, flush=True)


def decode_wav(data: bytes) -> np.ndarray:
    """16-bit PCM WAV to float32 in [-1, 1]. Scribe's browser side already
    resamples to 16 kHz mono, so anything else is a bug, not a case."""
    with wave.open(io.BytesIO(data), "rb") as wav:
        if wav.getframerate() != SAMPLE_RATE:
            raise ValueError(f"expected {SAMPLE_RATE} Hz, got {wav.getframerate()}")
        if wav.getsampwidth() != 2:
            raise ValueError(f"expected 16-bit samples, got {wav.getsampwidth() * 8}-bit")
        frames = wav.readframes(wav.getnframes())
        channels = wav.getnchannels()
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples


def transcribe(samples: np.ndarray, language: str | None, prompt: str | None) -> str:
    import mlx_whisper

    result = mlx_whisper.transcribe(
        samples,
        path_or_hf_repo=state["model"],
        language=language or None,
        initial_prompt=prompt or None,
        # Each chunk is its own request; Scribe supplies the context through
        # `prompt`, so letting the decoder condition on its own earlier
        # segments inside a 20-second chunk only helps a loop take hold.
        condition_on_previous_text=False,
        temperature=0.0,
        fp16=True,
    )
    return (result.get("text") or "").strip()


def warm_up() -> None:
    """Load the model (downloading it on first use) by transcribing a second
    of silence. mlx_whisper caches the loaded weights per repo, so the first
    real chunk does not pay for the load again."""
    started = time.time()
    log(f"loading {state['model']} (first run downloads it; a few hundred MB to 1.6 GB)")
    try:
        transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), "en", None)
    except Exception as error:  # noqa: BLE001 - reported over /health
        state["error"] = str(error)
        log(f"model failed to load: {error}")
        return
    state["ready"] = True
    log(f"ready in {time.time() - started:.1f}s")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:  # quiet the default access log
        pass

    def send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/health":
            return self.send_json(404, {"error": "not found"})
        self.send_json(200, {"ready": state["ready"], "model": state["model"], "error": state["error"]})

    def do_POST(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        if url.path != "/transcribe":
            return self.send_json(404, {"error": "not found"})
        if not state["ready"]:
            return self.send_json(503, {"error": "model still loading", "detail": state["error"]})

        query = parse_qs(url.query)
        language = (query.get("language") or [None])[0]
        prompt = (query.get("prompt") or [None])[0]
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)

        try:
            samples = decode_wav(body)
        except Exception as error:  # noqa: BLE001
            # wave raises a bare EOFError on a truncated header, so name the
            # type as well or the message is just "bad wav: ".
            return self.send_json(400, {"error": f"bad wav: {error or type(error).__name__}"})

        started = time.time()
        with lock:
            try:
                text = transcribe(samples, language, prompt)
            except Exception as error:  # noqa: BLE001
                log(f"transcription failed: {error}")
                return self.send_json(500, {"error": str(error)})
        self.send_json(200, {"text": text, "duration": round(time.time() - started, 3)})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()
    state["model"] = args.model

    threading.Thread(target=warm_up, daemon=True).start()
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    log(f"listening on http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
