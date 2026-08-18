# Scribe — live lecture transcription and summarisation

Design doc, 2026-08-18.

## What it is

A local web app that records a lecture from the laptop mic, transcribes it in
near-real-time through Groq Whisper, and keeps a running summary written by
Claude. Transcript and summary both persist to disk so a lecture can be reread
or re-summarised later.

It runs on localhost only. It is a personal tool, not a service.

## Why these choices

**Groq for speech, Claude for language.** Groq's `whisper-large-v3-turbo` costs
about $0.04 per hour of audio and returns a 20-second chunk in roughly a second,
which is what makes the transcript feel live. Claude does the part Whisper
cannot: deciding what mattered.

**Local web app rather than native.** The browser already solves microphone
capture, permissions, and audio worklets. A native menubar app would be nicer to
live with and several times the work for the same result.

**Chunked rather than streamed.** Groq's speech-to-text is batch-only — there is
no streaming endpoint — so chunking is not a design preference, it is the only
option. The chunk size sets the latency floor.

## Architecture

Three units, each independently testable.

```
browser (capture + UI)  →  server (orchestration)  →  Groq / Claude
        WAV chunks              SSE events
```

### 1. Capture (browser)

The obvious implementation is wrong and worth writing down so nobody
reintroduces it. `MediaRecorder.start(20000)` emits a chunk every 20 seconds,
but only the first one is a decodable WebM file — the rest are headerless
fragments of a single continuous stream. Groq rejects them. The usual
workaround, stopping and restarting the recorder for each chunk, does produce
valid files but drops audio at every seam. Over an hour that is 180 lost word
fragments.

So capture goes through an `AudioWorkletNode` instead:

1. `getUserMedia({audio: {echoCancellation: false, noiseSuppression: false}})` —
   both are tuned for speech *calls* and hurt transcription of a distant lecturer.
2. Worklet receives Float32 frames at the device rate (usually 48kHz), passes
   them to the main thread.
3. Main thread downsamples to 16kHz mono. This is Whisper's native rate, so
   doing it here costs nothing in quality and cuts upload size by two thirds.
4. Buffer until at least 15 seconds are held. Then scan the 15–25 second window
   for the lowest-RMS 100ms frame and cut there — a natural pause between words
   rather than mid-syllable. No overlap, so no duplicate text to reconcile.
5. Encode a 16-bit PCM WAV header around the slice and POST it.

A chunk is ~640KB. Over localhost this is free.

**Queueing.** Chunks go into a client-side queue with at most one upload in
flight. If the server is unreachable the queue grows; past a 2-minute cap the
oldest chunk is dropped and the UI warns. Recording itself never stops for a
network problem — that is the single most important behavioural requirement in
this document. A lecture happens once.

### 2. Transcription (server)

`POST /api/session/:id/chunk` accepts the WAV, writes it to disk, and calls
Groq's `/openai/v1/audio/transcriptions` with `whisper-large-v3-turbo`.

Each request carries `prompt` set to the last ~200 characters of transcript.
This is Whisper's documented mechanism for biasing decoding, and it is what
keeps proper nouns stable across chunk boundaries — without it a lecturer's name
or a technical term drifts to a different spelling every chunk, which makes the
transcript much harder to search later.

Retries: 3 attempts with exponential backoff, and 429 respects `retry-after`. A
chunk that still fails is written into the transcript as `[inaudible ~mm:ss]`.
The audio file is kept regardless, so a failed chunk can be re-transcribed
afterwards without having lost anything.

Transcript lines append to `transcript.md` as they arrive — the file is the
source of truth, not server memory, so a crashed process loses nothing.

### 3. Summarisation (server)

Two passes, both through the Anthropic TypeScript SDK.

**Running summary**, every 5 minutes. Takes the previous summary plus the new
transcript since the last pass, returns a replacement summary. Structured via
`output_config.format` so the UI renders sections rather than parsing prose:

- `topics` — what has been covered
- `keyPoints` — claims, arguments, results
- `definitions` — terms introduced, with their definitions
- `flagged` — anything the lecturer marked as important or exam-relevant
- `openQuestions` — things raised but not resolved

**Final summary** on stop, over the whole transcript, written to `summary.md`.

Both default to `claude-opus-5`. The running pass sets
`output_config: {effort: "low"}` — it is a fast incremental update and does not
need depth — and the final pass uses the default effort. `SCRIBE_RUNNING_MODEL`
can be set to `claude-sonnet-5` if the cost of the running pass ever matters;
the default stays Opus.

The transcript block carries `cache_control: {type: "ephemeral", ttl: "1h"}`.
Because each running pass re-sends a transcript that only ever grows at the end,
the earlier portion is a stable prefix and hits cache. Over an hour-long lecture
with twelve running passes this is the difference between paying for the
transcript twelve times and paying for it roughly once. The system prompt is
frozen — no timestamps, no session IDs — because a single varying byte anywhere
in the prefix invalidates everything after it.

Requests use `.stream()` with `.finalMessage()`. Long input plus a large
`max_tokens` is exactly the case where a non-streaming request hits an HTTP
timeout.

Adaptive thinking is left at its default (on, for Opus 5). No `budget_tokens` —
it is rejected with a 400 on this model family.

A failed summary pass is a no-op: log it, leave the previous summary standing,
try again next cycle. Summarisation is never allowed to affect recording.

### Server ↔ browser

One SSE stream per session, `GET /api/session/:id/events`, carrying:

- `transcript` — a new line, with its timestamp
- `summary` — a replacement running summary
- `status` — queue depth, chunk failures, cost so far

Plain REST for `POST /api/session` (start), `POST /api/session/:id/stop`, and
the chunk upload.

## Storage

```
~/scribe/sessions/<YYYY-MM-DD>-<slug>/
  meta.json        started, ended, duration, model IDs, token + cost totals
  transcript.md    appended live, timestamped
  summary.md       final summary, written on stop
  audio/000.wav …  raw chunks, kept
```

Audio is kept by default. It is the only irreplaceable artifact — the transcript
and summary can both be regenerated from it, and a lecture cannot be recorded
twice. `SCRIBE_KEEP_AUDIO=false` opts out.

## Configuration

`.env`, gitignored, seeded from `~/event-editor/.env`:

```
GROQ_API_KEY
ANTHROPIC_API_KEY
SCRIBE_CHUNK_SECONDS=20
SCRIBE_SUMMARY_INTERVAL_MINUTES=5
SCRIBE_RUNNING_MODEL=claude-opus-5
SCRIBE_FINAL_MODEL=claude-opus-5
SCRIBE_KEEP_AUDIO=true
SCRIBE_PORT=4747
```

Keys are read server-side only and never sent to the browser.

## Interface

Two panes: live transcript on the left, running summary on the right. A record
control, an elapsed timer, and a status line showing queue depth and any failed
chunks. Transcript auto-scrolls unless the user has scrolled up, in which case it
holds position and shows a "jump to live" affordance — reading back a definition
while the lecture continues is the normal case, not the exception.

Built to the `anti-vibecode` house standards.

## Testing

Unit:

- Silence-point chunker — picks the quietest frame in the window; falls back to
  a hard cut at the window edge when the audio is uniformly loud.
- WAV encoder — header field correctness, byte length, 16kHz mono.
- Transcript assembly — ordering under out-of-order chunk completion, and a
  failed chunk producing `[inaudible]` without dropping its neighbours.
- Summary prompt builder — cache breakpoint placement, and that the system
  prompt is byte-identical across calls.

Integration, behind `SCRIBE_LIVE_TESTS=1` so it does not run by default:

- A short sample WAV through the real Groq endpoint.
- A short transcript through the real Claude endpoint, asserting the structured
  output validates.

## Known limits

**Latency floor of about 22 seconds.** Batch STT plus a 20-second chunk. Not
fixable without a different provider.

**Chunked transcription is slightly less accurate than one long file**, because
each chunk is decoded without the surrounding acoustic context. The `prompt`
bias recovers most of the proper-noun drift but not all of it. Keeping the audio
means a full-file re-transcription is always available afterwards for anything
that matters.

**One speaker, undifferentiated.** No diarisation, so a lively Q&A reads as one
continuous block of text.

## Out of scope

System audio capture (needs BlackHole and a multi-output device), speaker
diarisation, slide capture and OCR, multi-user, any hosted deployment.
