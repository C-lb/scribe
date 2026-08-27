# Tier 1: a navigable transcript, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Scribe's transcript from a wall of text into something you can play, correct, mark and export, which is the parity gap against Otter.ai that blocks everything else.

**Architecture:** One new persisted artefact, `transcript.json`, carries structured lines (index, startMs, endMs, text, failed, edited) and flags per session, written on every flush next to the existing `transcript.md`. Everything else hangs off it: playback maps a line to its `audio/NNNN.wav`, flags carry a timestamp, edits rewrite a line in place, and the caption exports read it directly. Sessions also persist their own runtime state so a server restart no longer orphans a live recording. Nothing here needs a new API or a new model.

**Tech Stack:** Node 20, TypeScript, Express 4, vitest, vanilla ES modules in the browser, Groq whisper-large-v3-turbo, Anthropic SDK.

**Spec:** This plan is its own spec. The originating analysis is the Otter teardown at https://claude.ai/code/artifact/485ff184-f79a-4be9-ad98-b26b8f8b21b5, tier 1, six items. Each task below names the item it implements.

## Global constraints

- **Node 20+**, ES modules throughout, `.js` extensions on relative TypeScript imports.
- **No new runtime dependencies.** Everything here is doable with Node builtins, Express and the two SDKs already installed. If a task seems to need a package, stop and report rather than adding one.
- **Loopback only.** The server binds `127.0.0.1` deliberately (`src/server/index.ts`). No task may widen the bind or add CORS headers.
- **No secrets in any written artefact.** `meta.json` and every new file must never serialise the config object; both API keys live on it.
- **A control that cannot act says why**, in the reason line under the control, not only in a tooltip. This is an existing house pattern (`src/web/summary-export.js`). New controls follow it.
- **UI follows the anti-vibecode house standard** already encoded in `src/web/styles.css`: one accent, semantic colour for meaning only, flat buttons, sentence-case labels, no em dashes in any user-facing string.
- **Backward compatible with existing sessions.** Every session already on disk has `transcript.md` and no `transcript.json`. Reading a session must fall back to parsing the Markdown, never 404 or crash.
- **Tests:** `npm test` (unit, live suites skipped), `npm run typecheck`. Both must pass before every commit. Live suites (`SCRIBE_LIVE_TESTS=1`) are not run in this plan.
- **Commit after every task**, push to main immediately, no branching.

---

## File structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/server/transcript-file.ts` | Read and write `transcript.json`. Parse legacy `transcript.md` into lines. The single place that knows the on-disk shape. |
| `src/server/audio-routes.ts` | Serve chunk WAVs and the concatenated session WAV, with id and index validation. |
| `src/server/wav-join.ts` | Concatenate 16 kHz mono 16-bit WAV buffers into one valid WAV, and split a run of chunks into size-bounded windows. |
| `src/server/glossary.ts` | Normalise a term list into a Whisper prompt prefix, and correct drifted terms in a chunk of text. |
| `src/server/captions.ts` | Render lines as SRT, VTT and plain text. |
| `src/server/retranscribe.ts` | Re-transcribe a stopped session from its kept audio in size-bounded windows. |
| `src/web/playback.js` | Owns the single `<audio>` element: play a line, roll on into the next, report state back to the UI. |
| `src/web/flags.js` | The flag control and its keyboard shortcut, plus the flag list rendering. |
| `src/web/line-edit.js` | Inline correction of one transcript line. |
| `tests/transcript-file.test.ts`, `tests/wav-join.test.ts`, `tests/glossary.test.ts`, `tests/captions.test.ts`, `tests/audio-routes.test.ts`, `tests/retranscribe.test.ts`, `tests/session-restore.test.ts`, `tests/playback.test.js`, `tests/flags.test.js`, `tests/line-edit.test.js` | One suite per unit above. |

**Modified:**

| File | Change |
| --- | --- |
| `src/server/session.ts` | Write `transcript.json` and `session.json` on flush; hold a glossary; record flags; rehydrate from disk. |
| `src/server/transcript.ts` | Expose lines for serialisation and accept an edited line. |
| `src/server/index.ts` | New routes for flags and audio; rehydrate live sessions at boot. |
| `src/server/library.ts` | `LibraryCategory.terms?: string[]`. |
| `src/server/library-routes.ts` | Return structured `lines` from `GET /api/sessions/:id`; term list CRUD; line edit; re-transcribe; export routes. |
| `src/server/config.ts` | No change expected. Confirm before touching. |
| `src/web/app.js` | Wire playback, flags, line editing and the course select into the existing render path. |
| `src/web/index.html`, `src/web/styles.css` | Markup and styles for the new controls. |
| `src/web/summary-export.js` | Add the caption and text formats to the existing export controls. |
| `README.md` | Document every new control, route and file, and the re-transcription window limit. |

---

## Task 1: Structured transcript on disk

Nothing else in this plan works without it. Playback needs the real chunk index, not a position in a list. The existing client-side `parseTranscript` in `src/web/app.js:313` numbers lines by array position, which is wrong the moment a chunk is dropped as a silence artefact, and dropping those is current behaviour (`src/server/session.ts`).

**Files:**
- Create: `src/server/transcript-file.ts`
- Create: `tests/transcript-file.test.ts`
- Modify: `src/server/transcript.ts`
- Modify: `src/server/session.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TranscriptFlag { atMs: number; chunkIndex: number | null; note?: string }
  export interface TranscriptFileV1 {
    version: 1;
    lines: TranscriptLine[];        // from ./transcript.js, plus optional edited
    flags: TranscriptFlag[];
  }
  export function transcriptJsonPath(dir: string): string
  export async function writeTranscriptFile(dir: string, file: TranscriptFileV1): Promise<void>
  export async function readTranscriptFile(dir: string): Promise<TranscriptFileV1 | null>
  export function parseMarkdownLines(markdown: string): TranscriptLine[]
  export async function readLines(dir: string): Promise<{ lines: TranscriptLine[]; flags: TranscriptFlag[]; structured: boolean }>
  ```
- `TranscriptLine` gains one optional field in `src/server/transcript.ts`: `edited?: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/transcript-file.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeTranscriptFile, readLines, parseMarkdownLines } from "../src/server/transcript-file.js";

const line = (index: number, startMs: number, text: string) => ({
  index, startMs, endMs: startMs + 20_000, text, failed: false,
});

describe("readLines", () => {
  it("prefers transcript.json and keeps the real chunk indexes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scribe-"));
    // index 1 is missing: it was dropped as a silence artefact.
    await writeTranscriptFile(dir, {
      version: 1,
      lines: [line(0, 0, "Raft elects a leader"), line(2, 40_000, "The term number rises")],
      flags: [{ atMs: 40_000, chunkIndex: 2 }],
    });

    const read = await readLines(dir);
    expect(read.structured).toBe(true);
    expect(read.lines.map((l) => l.index)).toEqual([0, 2]);
    expect(read.flags).toEqual([{ atMs: 40_000, chunkIndex: 2 }]);
  });

  it("falls back to transcript.md for sessions recorded before this existed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scribe-"));
    await writeFile(path.join(dir, "transcript.md"), "[00:00] First line\n\n[00:20] Second line\n");

    const read = await readLines(dir);
    expect(read.structured).toBe(false);
    expect(read.lines).toEqual([
      { index: 0, startMs: 0, endMs: 20_000, text: "First line", failed: false },
      { index: 1, startMs: 20_000, endMs: 40_000, text: "Second line", failed: false },
    ]);
  });

  it("returns nothing for a directory with neither file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scribe-"));
    expect(await readLines(dir)).toEqual({ lines: [], flags: [], structured: false });
  });
});

describe("parseMarkdownLines", () => {
  it("marks an inaudible line as failed", () => {
    expect(parseMarkdownLines("[01:00] [inaudible ~01:00]")).toEqual([
      { index: 0, startMs: 60_000, endMs: 80_000, text: "[inaudible ~01:00]", failed: true },
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/transcript-file.test.ts`
Expected: FAIL, cannot resolve `../src/server/transcript-file.js`.

- [ ] **Step 3: Write `src/server/transcript-file.ts`**

Rules the implementation must hold to:
- `readLines` tries `transcript.json` first. A parse failure is logged and treated as absent, never thrown: a corrupt index file must not make a recording unreadable.
- The Markdown fallback derives `endMs` from the next line's `startMs`, and for the last line assumes the configured chunk length is not knowable here, so it uses `startMs + 20_000` and the caller treats a fallback session's `endMs` as approximate.
- A line whose text matches `/^\[inaudible ~\d\d:\d\d\]$/` is `failed: true`.
- `writeTranscriptFile` writes atomically: write `transcript.json.tmp` in the same directory, then `rename`. A half-written index file on a crash is worse than none.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/transcript-file.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Have `Transcript` expose its lines and `Session` write the file**

In `src/server/transcript.ts`, add `edited?: boolean` to `TranscriptLine` and a method:

```ts
/** Replace one line's text, marking it as human-corrected. Returns null if
 *  the index is not in this transcript, which the caller reports as a 404. */
edit(index: number, text: string): TranscriptLine | null {
  const existing = this.byIndex.get(index);
  if (!existing) return null;
  const next: TranscriptLine = { ...existing, text: text.trim(), failed: false, edited: true };
  this.byIndex.set(index, next);
  return next;
}
```

In `src/server/session.ts`, every existing `await this.transcript.flush()` becomes `await this.persist()`, where:

```ts
/** transcript.md stays the human artefact; transcript.json is the one the app
 *  reads back, because Markdown loses the chunk index and the millisecond. */
private async persist(): Promise<void> {
  await this.transcript.flush();
  await writeTranscriptFile(this.dir, {
    version: 1,
    lines: this.transcript.lines(),
    flags: this.flags,
  }).catch((error) => console.error("[scribe] failed to write transcript.json:", error));
}
```

`private flags: TranscriptFlag[] = []` is added now and filled in Task 4.

- [ ] **Step 6: Run the whole suite and the typechecker**

Run: `npm test && npm run typecheck`
Expected: all existing tests still pass; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/transcript-file.ts src/server/transcript.ts src/server/session.ts tests/transcript-file.test.ts
git commit -m "Write transcript.json next to transcript.md"
git push origin HEAD
```

---

## Task 2: Click a line, hear it

Tier 1 item 1, the highest-value item in the teardown.

**Files:**
- Create: `src/server/wav-join.ts`, `tests/wav-join.test.ts`
- Create: `src/server/audio-routes.ts`, `tests/audio-routes.test.ts`
- Create: `src/web/playback.js`, `tests/playback.test.js`
- Modify: `src/server/index.ts`, `src/server/session.ts`, `src/web/app.js`, `src/web/index.html`, `src/web/styles.css`

**Interfaces:**
- Consumes: `readLines` from Task 1.
- Produces:
  ```ts
  // wav-join.ts
  export function joinWavs(buffers: Buffer[]): Buffer            // 16 kHz mono 16-bit in, one WAV out
  export function windowsByByteBudget(sizes: number[], budgetBytes: number): number[][]  // arrays of chunk indexes
  // audio-routes.ts
  export function createAudioRouter(deps: { config: Config }): express.Router
  ```
  ```js
  // playback.js
  export function createPlayback({ audioEl, onState }) // -> { playLine(sessionId, line, { continuous }), stop(), state() }
  ```
- Routes: `GET /api/sessions/:id/audio/:index` returns one chunk WAV, `GET /api/sessions/:id/audio.wav` returns the whole session.

- [ ] **Step 1: Write the failing WAV test**

```ts
// tests/wav-join.test.ts
import { describe, it, expect } from "vitest";
import { joinWavs, windowsByByteBudget } from "../src/server/wav-join.js";

/** A 44-byte header plus `samples` 16-bit samples of a constant value. */
function wav(samples: number, value = 1): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(value, i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("joinWavs", () => {
  it("produces one header and every sample", () => {
    const joined = joinWavs([wav(10, 1), wav(5, 2)]);
    expect(joined.length).toBe(44 + 15 * 2);
    expect(joined.toString("ascii", 0, 4)).toBe("RIFF");
    expect(joined.readUInt32LE(4)).toBe(36 + 15 * 2);
    expect(joined.readUInt32LE(40)).toBe(15 * 2);
    expect(joined.readUInt32LE(24)).toBe(16000);
    expect(joined.readInt16LE(44)).toBe(1);
    expect(joined.readInt16LE(44 + 10 * 2)).toBe(2);
  });

  it("returns a valid empty WAV for no input", () => {
    expect(joinWavs([]).length).toBe(44);
  });
});

describe("windowsByByteBudget", () => {
  it("packs chunks up to the budget without splitting one", () => {
    expect(windowsByByteBudget([4, 4, 4, 4], 9)).toEqual([[0, 1], [2, 3]]);
  });

  it("gives an oversized chunk a window of its own", () => {
    expect(windowsByByteBudget([20, 3], 9)).toEqual([[0], [1]]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/wav-join.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/server/wav-join.ts`**

`joinWavs` reads each input's `data` chunk size from bytes 40 to 43 and its payload from byte 44, concatenates the payloads, then writes one 44-byte header with the summed length, 16000 Hz, mono, 16-bit. It must not assume every input has the same length, only the same format, and it must reject a buffer shorter than 44 bytes with a named error rather than producing silent garbage.

`windowsByByteBudget` is a plain greedy packer over the sizes, preserving order.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/wav-join.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing route test**

```ts
// tests/audio-routes.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAudioRouter } from "../src/server/audio-routes.js";

let dir: string;
const app = () => {
  const a = express();
  a.use(createAudioRouter({ config: { sessionsDir: dir } as never }));
  return a;
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "scribe-"));
  await mkdir(path.join(dir, "2026-08-27-10-00-00", "audio"), { recursive: true });
  await writeFile(path.join(dir, "2026-08-27-10-00-00", "audio", "0002.wav"), Buffer.alloc(44));
});

describe("GET /api/sessions/:id/audio/:index", () => {
  it("serves a chunk as audio/wav", async () => {
    const res = await request(app()).get("/api/sessions/2026-08-27-10-00-00/audio/2");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/wav");
  });

  it("404s an index with no file", async () => {
    const res = await request(app()).get("/api/sessions/2026-08-27-10-00-00/audio/9");
    expect(res.status).toBe(404);
  });

  it("rejects a traversing session id", async () => {
    const res = await request(app()).get("/api/sessions/..%2F..%2Fetc/audio/0");
    expect(res.status).toBe(400);
  });

  it("rejects a non-integer index", async () => {
    const res = await request(app()).get("/api/sessions/2026-08-27-10-00-00/audio/0;rm");
    expect(res.status).toBe(400);
  });
});
```

Note: `supertest` is already a dev dependency, used by `tests/server.test.ts`. Confirm with `grep supertest package.json` before writing; if it is absent, drive the router with `createApp` the way `tests/server.test.ts` does instead of adding a package.

- [ ] **Step 6: Run it and watch it fail, then write `src/server/audio-routes.ts`**

Run: `npx vitest run tests/audio-routes.test.ts` (expect FAIL, module not found).

The router mirrors the guards already used by the reveal route in `src/server/library-routes.ts:238`, which is the existing house pattern for user input reaching the filesystem:
- `isSessionId(id)` or 400.
- `Number.isInteger(Number(index)) && Number(index) >= 0` or 400.
- Build the path as `path.join(sessionsDir, id, "audio", `${String(index).padStart(4, "0")}.wav`)`, then re-check it resolves inside `path.resolve(sessionsDir, id, "audio")` or 400.
- `res.type("audio/wav")` and stream the file; ENOENT is a 404, anything else a logged 500.
- `GET /api/sessions/:id/audio.wav` prefers a `full.wav` written at stop; if absent, it joins the chunks on the fly with `joinWavs`, which is fine for a read of a session that never completed.

- [ ] **Step 7: Run and watch it pass; mount the router**

Run: `npx vitest run tests/audio-routes.test.ts`
Expected: PASS, 4 tests.

In `src/server/index.ts`, mount it next to the library router: `app.use(createAudioRouter({ config }));` before `express.static`.

In `src/server/session.ts`, at the end of `stop()` and only when `config.keepAudio`, write the concatenated file:

```ts
// One file the whole lecture scrubs through. Chunk files stay: they are the
// unit re-transcription works in, and joining is cheap to redo.
try {
  const names = (await readdir(path.join(this.dir, "audio"))).filter((n) => n.endsWith(".wav")).sort();
  const buffers = await Promise.all(names.map((n) => readFile(path.join(this.dir, "audio", n))));
  await writeFile(path.join(this.dir, "audio", "full.wav"), joinWavs(buffers));
} catch (error) {
  console.error("[scribe] could not write full.wav:", error);
}
```

`full.wav` must be excluded from the chunk listing by name, since it lives in the same directory: filter `n !== "full.wav"`.

- [ ] **Step 8: Write the failing playback test**

```js
// tests/playback.test.js
import { describe, it, expect, vi } from "vitest";
import { createPlayback } from "../src/web/playback.js";

const fakeAudio = () => ({
  src: "", currentTime: 0, paused: true,
  play: vi.fn(function () { this.paused = false; return Promise.resolve(); }),
  pause: vi.fn(function () { this.paused = true; }),
  addEventListener: vi.fn(),
});

describe("createPlayback", () => {
  it("points the element at the clicked line's chunk", async () => {
    const audioEl = fakeAudio();
    const playback = createPlayback({ audioEl, onState: () => {} });
    await playback.playLine("2026-08-27-10-00-00", { index: 3 }, { continuous: false });
    expect(audioEl.src).toBe("/api/sessions/2026-08-27-10-00-00/audio/3");
    expect(audioEl.play).toHaveBeenCalled();
  });

  it("reports the playing line so the row can show it", async () => {
    const onState = vi.fn();
    const playback = createPlayback({ audioEl: fakeAudio(), onState });
    await playback.playLine("s", { index: 3 }, { continuous: false });
    expect(onState).toHaveBeenCalledWith({ playingIndex: 3, continuous: false });
  });

  it("clicking the playing line stops it", async () => {
    const audioEl = fakeAudio();
    const onState = vi.fn();
    const playback = createPlayback({ audioEl, onState });
    await playback.playLine("s", { index: 3 }, { continuous: false });
    await playback.playLine("s", { index: 3 }, { continuous: false });
    expect(audioEl.pause).toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith({ playingIndex: null, continuous: false });
  });

  it("in continuous mode, ending a chunk advances to the next line", async () => {
    const audioEl = fakeAudio();
    const playback = createPlayback({ audioEl, onState: () => {} });
    playback.setLines([{ index: 0 }, { index: 2 }, { index: 3 }]);
    await playback.playLine("s", { index: 0 }, { continuous: true });
    const ended = audioEl.addEventListener.mock.calls.find(([name]) => name === "ended")[1];
    await ended();
    // index 1 was dropped as a silence artefact, so the next line is 2, not 1.
    expect(audioEl.src).toBe("/api/sessions/s/audio/2");
  });
});
```

- [ ] **Step 9: Run it, watch it fail, then write `src/web/playback.js`**

Run: `npx vitest run tests/playback.test.js` (expect FAIL).

The module owns one `<audio>` element and nothing else. It knows the current line list so continuous play can find the next real index rather than assuming `index + 1`, which is exactly the bug a dropped silence artefact would cause.

- [ ] **Step 10: Wire it into the transcript pane**

In `src/web/index.html`, add one element inside the transcript pane head: `<audio id="player" preload="none"></audio>`.

In `src/web/app.js`:
- `appendLine` gains `el.dataset.index = String(line.index)` and, when playback is available, `el.classList.add("line--playable")` plus `role="button"` and `tabindex="0"`.
- One delegated listener on `transcriptEl` handles click and the Enter and Space keys: `playback.playLine(currentSessionId, line, { continuous: event.shiftKey })`.
- `onState` toggles `line--playing` on the matching row, which is the visible feedback the house standard requires. No new colour: the existing accent token.
- Playback is unavailable when the session has no audio on disk. `GET /api/sessions/:id` (Task 1 changed it to return `lines`) also returns `hasAudio: boolean`. When false, rows are not playable and the transcript pane's reason line says "This session was recorded with SCRIBE_KEEP_AUDIO off, so there is no audio to play." Follow the existing reason-line pattern in `src/web/summary-export.js`.

In `src/web/styles.css`, add `.line--playable` (pointer cursor, hover surface step, focus ring from the existing token) and `.line--playing` (accent-tinted time stamp). No new tokens, no side accent bar.

- [ ] **Step 11: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "Play a transcript line by clicking it"
git push origin HEAD
```

---

## Task 3: A term list that binds

Tier 1 item 2. Direct fix for the drift documented in the README, where "Raft" became "RAF" for the rest of a lecture because the mistranscription entered the bias prompt's own tail.

**Files:**
- Create: `src/server/glossary.ts`, `tests/glossary.test.ts`
- Modify: `src/server/library.ts`, `src/server/library-routes.ts`, `src/server/session.ts`, `src/server/index.ts`, `src/web/app.js`, `src/web/history.js`, `src/web/index.html`, `src/web/styles.css`

**Interfaces:**
- Produces:
  ```ts
  export function promptPrefix(terms: string[], maxChars?: number): string   // default 160
  export function correct(text: string, terms: string[]): string
  ```
- `LibraryCategory` gains `terms?: string[]`.
- `POST /api/sessions` accepts an optional `{ categoryId }` and files the session immediately.
- `PATCH /api/categories/:id` accepts `{ terms: string[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/glossary.test.ts
import { describe, it, expect } from "vitest";
import { promptPrefix, correct } from "../src/server/glossary.js";

describe("promptPrefix", () => {
  it("joins terms into a phrase Whisper accepts as a prompt", () => {
    expect(promptPrefix(["Raft", "Paxos"])).toBe("Raft, Paxos.");
  });

  it("stops at the character budget rather than truncating a term", () => {
    expect(promptPrefix(["aaaa", "bbbb", "cccc"], 12)).toBe("aaaa, bbbb.");
  });

  it("is empty for no terms, so the caller can omit the prompt entirely", () => {
    expect(promptPrefix([])).toBe("");
  });
});

describe("correct", () => {
  it("restores a term that lost its capitalisation", () => {
    expect(correct("the raft protocol", ["Raft"])).toBe("the Raft protocol");
  });

  it("restores a term Whisper clipped a letter from", () => {
    expect(correct("makes RAF tolerant of partitions", ["Raft"])).toBe("makes Raft tolerant of partitions");
  });

  it("leaves a word alone when it is already another glossary term", () => {
    expect(correct("Paxos and Raft", ["Raft", "Paxos"])).toBe("Paxos and Raft");
  });

  it("does not touch a short term, where one letter of distance is a different word", () => {
    // "cap" is three letters, so fuzzy matching is off: "cat" stays a cat.
    expect(correct("the cat sat", ["cap"])).toBe("the cat sat");
  });

  it("only matches whole words", () => {
    expect(correct("drafting a note", ["Raft"])).toBe("drafting a note");
  });

  it("is a no-op with no terms", () => {
    expect(correct("anything at all", [])).toBe("anything at all");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/glossary.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/server/glossary.ts`**

Two tiers of matching, and the second one is deliberately timid because a false correction is worse than a missed one:

1. **Exact, case-insensitive.** A token whose lowercase form equals a term's lowercase form is replaced with the term's own spelling. This is what fixes "raft" to "Raft".
2. **Distance one, gated.** Only for terms of four characters or more, and only when the token is not itself an exact match for any term and is not a word already spelled by another term. Levenshtein distance of exactly one, computed with a small local function, no dependency. This is what fixes "RAF" to "Raft".

Tokenise on word boundaries with a regex that keeps punctuation outside the token, and rebuild the string so spacing and punctuation survive untouched. The function must never change the number of tokens.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/glossary.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Carry terms on a category and hand them to the session**

In `src/server/library.ts`, add `terms?: string[]` to `LibraryCategory`, and accept it in `updateCategory`'s patch: trim each entry, drop empties, cap the list at 100 terms and each term at 60 characters, and throw a named `Error` on anything else so `mutate` reports it as a 400, which is the existing convention in that file.

In `src/server/index.ts`, `POST /api/sessions` reads an optional `categoryId` from the body, looks up that category's terms from the library, passes them to `Session.create`, and files the new session into the category with the existing `setEntry`. An unknown `categoryId` is a 400, not a silent ignore.

In `src/server/session.ts`:

```ts
// Terms go in front of the trailing transcript, not instead of it. Whisper's
// prompt is a bias, not a rule, and the tail is what keeps a sentence
// continuous across a chunk boundary.
const prefix = promptPrefix(this.terms);
const tail = this.transcript.tail(200);
const prompt = [prefix, tail].filter(Boolean).join(" ") || undefined;
```

and, after the hallucination filter, before recording the line:

```ts
// Corrected here rather than at read time, so a drifted term never reaches
// the next chunk's bias prompt. That feedback loop is what turned one bad
// "RAF" into every later chunk saying "RAF".
const text = correct(filterChunkText(raw), this.terms);
```

- [ ] **Step 6: Write the tests for both wirings**

Add to `tests/session.test.ts`:

```ts
it("puts the glossary in front of the bias prompt and corrects drift", async () => {
  const prompts: (string | undefined)[] = [];
  const session = await Session.create(configWithTerms(["Raft"]), {
    ...deps,
    transcribe: async ({ prompt }) => { prompts.push(prompt); return "makes RAF tolerant"; },
  });
  await session.ingestChunk({ index: 0, startMs: 0, endMs: 20_000, audio: Buffer.alloc(0) });
  await session.ingestChunk({ index: 1, startMs: 20_000, endMs: 40_000, audio: Buffer.alloc(0) });

  expect(prompts[0]).toBe("Raft.");
  // The second prompt carries the corrected tail, never the drifted one.
  expect(prompts[1]).toContain("Raft");
  expect(prompts[1]).not.toContain("RAF ");
});
```

Match the existing helpers in that file rather than inventing new ones; read it first.

- [ ] **Step 7: The course select in the header**

`src/web/index.html` gets a `<select id="course">` beside the existing microphone select, labelled "Course" on its own line, because a label never shares a line with the control it names. Options come from `GET /api/library` categories, with "No course" first and selected by default. The choice is remembered in `localStorage` the way the drawer's open state already is, wrapped in try/catch.

`src/web/app.js` sends `{ categoryId }` with `POST /api/sessions`. The select is disabled during a recording, with the reason line saying "The course is fixed once recording starts."

- [ ] **Step 8: Editing the term list**

In `src/web/history.js`, the category context menu gains "Edit terms", which opens the existing rename-style inline editor in a textarea, one term per line. Save issues `PATCH /api/categories/:id` with `{ terms }`. Status line confirms with "Saved 12 terms for Financial modelling."

Seeding a list from a syllabus with Claude is **out of scope for this task** and must not be attempted here: it needs a file upload path and a PDF parser, and no new dependency is allowed. Note it in the README as a known gap rather than half-building it.

- [ ] **Step 9: Run everything and commit**

```bash
npm test && npm run typecheck
git add -A
git commit -m "Bind a course term list into transcription"
git push origin HEAD
```

---

## Task 4: One key to flag a moment

Tier 1 item 3.

**Files:**
- Create: `src/web/flags.js`, `tests/flags.test.js`
- Modify: `src/server/index.ts`, `src/server/session.ts`, `src/server/events.ts`, `src/server/claude.ts`, `src/web/app.js`, `src/web/index.html`, `src/web/styles.css`

**Interfaces:**
- Consumes: `TranscriptFlag` from Task 1, `playback` from Task 2.
- Produces: `POST /api/sessions/:id/flag` with body `{ atMs: number }`, answering `{ flag: TranscriptFlag }`. New SSE event `{ type: "flag"; flag: TranscriptFlag }`.

- [ ] **Step 1: Write the failing server test**

Add to `tests/server.test.ts`, following its existing style:

```ts
it("records a flag against the chunk that was recording at the time", async () => {
  const { app, session } = await startedSession();
  await request(app).post(`/api/sessions/${session.id}/chunk`)
    .set("Content-Type", "audio/wav")
    .set({ "X-Chunk-Index": "0", "X-Chunk-Start-Ms": "0", "X-Chunk-End-Ms": "20000" })
    .send(Buffer.alloc(0));

  const res = await request(app).post(`/api/sessions/${session.id}/flag`).send({ atMs: 12_000 });
  expect(res.status).toBe(200);
  expect(res.body.flag).toEqual({ atMs: 12_000, chunkIndex: 0 });
});

it("rejects a flag with no usable timestamp", async () => {
  const { app, session } = await startedSession();
  const res = await request(app).post(`/api/sessions/${session.id}/flag`).send({ atMs: "soon" });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run it, watch it fail, then implement the route and `Session.flag`**

```ts
/** A flag is a timestamp, nothing more. Resolving it to a chunk is best
 *  effort: a flag dropped during the chunk still being recorded has no line
 *  yet, and chunkIndex stays null until the transcript catches up. */
flag(atMs: number): TranscriptFlag {
  const line = this.transcript.lines().find((l) => atMs >= l.startMs && atMs < l.endMs);
  const flag: TranscriptFlag = { atMs, chunkIndex: line?.index ?? null };
  this.flags.push(flag);
  this.events.publish({ type: "flag", flag });
  void this.persist();
  return flag;
}
```

The route validates `Number.isFinite(atMs) && atMs >= 0` or 400, mirroring the chunk header validation already in `src/server/index.ts:44`.

- [ ] **Step 3: Write the failing client test**

```js
// tests/flags.test.js
import { describe, it, expect, vi } from "vitest";
import { createFlags } from "../src/web/flags.js";

describe("createFlags", () => {
  it("posts the elapsed time when the key is pressed", async () => {
    const post = vi.fn().mockResolvedValue({ flag: { atMs: 5000, chunkIndex: 0 } });
    const flags = createFlags({ post, elapsedMs: () => 5000, setStatus: vi.fn() });
    await flags.mark();
    expect(post).toHaveBeenCalledWith(5000);
  });

  it("confirms in the status line, because a keypress with no response is a dead key", async () => {
    const setStatus = vi.fn();
    const flags = createFlags({
      post: vi.fn().mockResolvedValue({ flag: { atMs: 63_000, chunkIndex: 3 } }),
      elapsedMs: () => 63_000,
      setStatus,
    });
    await flags.mark();
    expect(setStatus).toHaveBeenCalledWith("Flagged at 01:03");
  });

  it("says so when the flag did not land", async () => {
    const setStatus = vi.fn();
    const flags = createFlags({
      post: vi.fn().mockRejectedValue(new Error("offline")),
      elapsedMs: () => 1000,
      setStatus,
    });
    await flags.mark();
    expect(setStatus).toHaveBeenCalledWith("Could not flag that moment: offline");
  });
});
```

- [ ] **Step 4: Run it, watch it fail, write `src/web/flags.js`, watch it pass**

Run: `npx vitest run tests/flags.test.js`

- [ ] **Step 5: The control itself**

`src/web/index.html` gets a "Flag" button next to the record button, disabled unless recording, with the reason line saying "Flagging needs a recording in progress." `src/web/app.js` binds the `f` key to the same action, ignoring it while focus is in an input, textarea or contenteditable, so typing a session name never drops a flag.

Flagged lines get `line--flagged` in the transcript pane and a marker in the time stamp column. Existing semantic warning token, no new colour.

- [ ] **Step 6: Flags in the final document**

In `src/server/claude.ts`, the final summariser takes the flags and appends a section to the returned Markdown:

```
## Marked in the room

- **01:03** the transcript line at that moment
```

The section is appended after the model returns, not asked for in the prompt: the flags are ground truth from the person in the room, and a model given them as prose might paraphrase or drop them. Add a unit test asserting a flagged session's `summary.md` contains the section and the timestamp, and that a session with no flags gets no empty heading.

- [ ] **Step 7: Run everything and commit**

```bash
npm test && npm run typecheck
git add -A
git commit -m "Flag a moment while the lecture runs"
git push origin HEAD
```

---

## Task 5: Edit a line, and re-transcribe on demand

Tier 1 item 4. Note the real constraint found while planning: Groq's transcription endpoint caps uploads at 25 MB, and Scribe's audio is 16 kHz mono 16-bit, which is 1.92 MB per minute. A whole 90-minute lecture is roughly 172 MB, so "re-transcribe the concatenated file" cannot be one request. It is re-transcribed in windows of about ten minutes, each carrying the previous window's tail as its bias prompt. That is still far better context than a 20-second chunk, and the README's claim needs correcting to match.

**Files:**
- Create: `src/server/retranscribe.ts`, `tests/retranscribe.test.ts`
- Create: `src/web/line-edit.js`, `tests/line-edit.test.js`
- Modify: `src/server/library-routes.ts`, `src/web/app.js`, `src/web/styles.css`, `README.md`

**Interfaces:**
- Consumes: `joinWavs` and `windowsByByteBudget` from Task 2, `promptPrefix` and `correct` from Task 3, `readLines` and `writeTranscriptFile` from Task 1.
- Produces:
  ```ts
  export const WINDOW_BUDGET_BYTES = 20 * 1024 * 1024;   // under Groq's 25 MB, with headroom
  export async function retranscribe(deps: {
    dir: string;
    terms: string[];
    transcribe(input: { audio: Buffer; prompt?: string }): Promise<string>;
  }): Promise<{ lines: TranscriptLine[]; windows: number }>
  ```
- Routes: `PATCH /api/sessions/:id/lines/:index` with `{ text }`, and `POST /api/sessions/:id/retranscribe`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/retranscribe.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { retranscribe } from "../src/server/retranscribe.js";

async function sessionWithChunks(count: number, bytesEach: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "scribe-"));
  await mkdir(path.join(dir, "audio"), { recursive: true });
  for (let i = 0; i < count; i++) {
    const wav = Buffer.alloc(44 + bytesEach);
    wav.write("RIFF", 0, "ascii");
    wav.writeUInt32LE(36 + bytesEach, 4);
    wav.write("WAVE", 8, "ascii");
    wav.write("data", 36, "ascii");
    wav.writeUInt32LE(bytesEach, 40);
    await writeFile(path.join(dir, "audio", `${String(i).padStart(4, "0")}.wav`), wav);
  }
  return dir;
}

describe("retranscribe", () => {
  it("sends one request per window, not one per chunk", async () => {
    const dir = await sessionWithChunks(4, 1000);
    const transcribe = vi.fn().mockResolvedValue("some text");
    const result = await retranscribe({ dir, terms: [], transcribe });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(result.windows).toBe(1);
  });

  it("carries the previous window's tail into the next prompt", async () => {
    const dir = await sessionWithChunks(2, 15 * 1024 * 1024);
    const transcribe = vi.fn()
      .mockResolvedValueOnce("first window ends here")
      .mockResolvedValueOnce("second window");
    await retranscribe({ dir, terms: ["Raft"], transcribe });
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[0][0].prompt).toBe("Raft.");
    expect(transcribe.mock.calls[1][0].prompt).toContain("first window ends here");
  });

  it("ignores full.wav so the audio is not transcribed twice", async () => {
    const dir = await sessionWithChunks(2, 1000);
    await writeFile(path.join(dir, "audio", "full.wav"), Buffer.alloc(44));
    const transcribe = vi.fn().mockResolvedValue("text");
    await retranscribe({ dir, terms: [], transcribe });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("refuses a session with no kept audio rather than wiping its transcript", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scribe-"));
    await expect(retranscribe({ dir, terms: [], transcribe: vi.fn() })).rejects.toThrow(/no audio/i);
  });
});
```

- [ ] **Step 2: Run it, watch it fail, write `src/server/retranscribe.ts`**

Each window becomes one line spanning the window's own start and end milliseconds, derived from the byte offsets of its chunks (bytes / 32000 = seconds). The result replaces `transcript.json` and rewrites `transcript.md`, and the previous chunked transcript is kept as `transcript.chunked.md` so nothing is destroyed. Corrections from Task 3's `correct` run over each window's text.

- [ ] **Step 3: Run and watch it pass**

Run: `npx vitest run tests/retranscribe.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 4: The two routes**

`PATCH /api/sessions/:id/lines/:index` is refused with 409 while that session is recording, because the live transcript belongs to the recorder and the same reasoning already governs the reading pane. Otherwise it loads `transcript.json`, replaces the line's text, marks `edited: true`, rewrites both files and answers with the line.

`POST /api/sessions/:id/retranscribe` is refused with 409 while recording, answers 202 immediately, and runs in the background, publishing progress to the same SSE stream so the pane can say "Re-transcribing, window 2 of 9." The cost estimate is written back into `meta.json` as `retranscribedAt` and an added cost figure, since the audio is billed again.

- [ ] **Step 5: Inline editing in the pane**

`src/web/line-edit.js`: double-click a line to edit it, Enter saves, Escape abandons. This mirrors the rename interaction the drawer already has, which the README documents, so the gesture is already learned. An edited line shows a quiet marker and its tooltip says when it was corrected.

Test the module the way `tests/dnd.test.js` tests the drag behaviour: construct the DOM, dispatch events, assert on the calls made.

- [ ] **Step 6: Correct the README's claim**

The "Chunked transcription is less accurate than one long file" section currently implies a full re-transcription is one pass. Replace with the window mechanism and the 25 MB arithmetic. Do not soften the existing account of the Raft drift: Task 3 reduces it, and the honest line is that it reduces it rather than removes it.

- [ ] **Step 7: Run everything and commit**

```bash
npm test && npm run typecheck
git add -A
git commit -m "Edit a line, and re-transcribe from the kept audio"
git push origin HEAD
```

---

## Task 6: Persist the session to disk

Tier 1 item 5. Today a `Session` lives only in a `Map` in the running process, so a restart mid-lecture orphans the recording: the browser keeps queuing chunks and every one it sends afterwards gets a 404.

**Files:**
- Create: `tests/session-restore.test.ts`
- Modify: `src/server/session.ts`, `src/server/index.ts`, `README.md`

**Interfaces:**
- Produces:
  ```ts
  export interface SessionStateV1 {
    version: 1;
    id: string;
    recording: boolean;
    audioSeconds: number;
    failedChunks: number;
    silenceArtefacts: number;
    lastSummarisedIndex: number;
    categoryId: string | null;
    terms: string[];
  }
  static async restore(dir: string, config: Config, deps: SessionDeps): Promise<Session | null>
  export async function restoreLiveSessions(config: Config, deps: SessionDeps): Promise<Session[]>
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/session-restore.test.ts
import { describe, it, expect } from "vitest";
import { Session } from "../src/server/session.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("session state on disk", () => {
  it("writes session.json as the recording runs", async () => {
    const session = await Session.create(config, deps);
    await session.ingestChunk({ index: 0, startMs: 0, endMs: 20_000, audio: Buffer.alloc(0) });
    const state = JSON.parse(await readFile(path.join(session.dir, "session.json"), "utf8"));
    expect(state).toMatchObject({ version: 1, recording: true, id: session.id });
  });

  it("marks the session finished when it stops", async () => {
    const session = await Session.create(config, deps);
    await session.stop();
    const state = JSON.parse(await readFile(path.join(session.dir, "session.json"), "utf8"));
    expect(state.recording).toBe(false);
  });

  it("restores a recording that was interrupted, and accepts the next chunk", async () => {
    const first = await Session.create(config, deps);
    await first.ingestChunk({ index: 0, startMs: 0, endMs: 20_000, audio: Buffer.alloc(0) });

    // The process died here. Nothing calls stop().
    const restored = await Session.restore(first.dir, config, deps);
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(first.id);
    expect(restored!.isRecording).toBe(true);

    await restored!.ingestChunk({ index: 1, startMs: 20_000, endMs: 40_000, audio: Buffer.alloc(0) });
    const lines = JSON.parse(await readFile(path.join(first.dir, "transcript.json"), "utf8")).lines;
    expect(lines.map((l: { index: number }) => l.index)).toEqual([0, 1]);
  });

  it("does not restore a session that stopped cleanly", async () => {
    const session = await Session.create(config, deps);
    await session.stop();
    expect(await Session.restore(session.dir, config, deps)).toBeNull();
  });
});
```

Read `tests/session.test.ts` first and reuse its `config` and `deps` fixtures rather than writing new ones.

- [ ] **Step 2: Run it, watch it fail, implement**

`persist()` from Task 1 also writes `session.json`. `Session.restore` reads it, returns null unless `recording` is true, then rebuilds the instance with the counters and the transcript loaded from `transcript.json`. `restoreLiveSessions` scans `sessionsDir` for directories whose `session.json` says recording, newest first, and is called from the boot block in `src/server/index.ts` before `listen`, seeding the same `Map` the routes read.

A restored session's `lastSummaryAt` is set to now, so a restart does not trigger an immediate summary of the whole lecture so far.

- [ ] **Step 3: Run and watch it pass**

Run: `npx vitest run tests/session-restore.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 4: Replace the README's known limitation**

The "Sessions live in server memory only" section is now wrong. Replace it with what actually happens on restart, and keep an honest note about what is still lost: chunks the browser dropped while the server was down are gone, because the browser's queue is bounded.

- [ ] **Step 5: Run everything and commit**

```bash
npm test && npm run typecheck
git add -A
git commit -m "Survive a server restart mid-recording"
git push origin HEAD
```

---

## Task 7: SRT, VTT, PDF and plain text

Tier 1 item 6.

**Files:**
- Create: `src/server/captions.ts`, `tests/captions.test.ts`
- Modify: `src/server/library-routes.ts`, `src/web/summary-export.js`, `src/web/index.html`, `src/web/styles.css`, `README.md`

**Interfaces:**
- Consumes: `readLines` from Task 1.
- Produces:
  ```ts
  export function toSrt(lines: TranscriptLine[]): string
  export function toVtt(lines: TranscriptLine[]): string
  export function toPlainText(lines: TranscriptLine[]): string
  ```
- Route: `GET /api/sessions/:id/transcript.:format` where format is `srt`, `vtt` or `txt`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/captions.test.ts
import { describe, it, expect } from "vitest";
import { toSrt, toVtt, toPlainText } from "../src/server/captions.js";

const lines = [
  { index: 0, startMs: 0, endMs: 20_000, text: "First line", failed: false },
  { index: 2, startMs: 40_000, endMs: 63_500, text: "Third line", failed: false },
];

describe("toSrt", () => {
  it("numbers cues from one and uses comma milliseconds", () => {
    expect(toSrt(lines)).toBe(
      "1\n00:00:00,000 --> 00:00:20,000\nFirst line\n\n" +
      "2\n00:00:40,000 --> 00:01:03,500\nThird line\n",
    );
  });

  it("renumbers rather than reusing chunk indexes, because a dropped chunk leaves a hole", () => {
    expect(toSrt(lines).startsWith("1\n")).toBe(true);
    expect(toSrt(lines)).toContain("\n2\n");
  });
});

describe("toVtt", () => {
  it("opens with the WEBVTT header and uses dot milliseconds", () => {
    expect(toVtt(lines).startsWith("WEBVTT\n\n")).toBe(true);
    expect(toVtt(lines)).toContain("00:00:00.000 --> 00:00:20.000");
  });
});

describe("toPlainText", () => {
  it("drops the timestamps and joins into paragraphs", () => {
    expect(toPlainText(lines)).toBe("First line\n\nThird line\n");
  });

  it("leaves out a failed line rather than writing [inaudible] into a caption file", () => {
    const withFailure = [...lines, { index: 3, startMs: 63_500, endMs: 80_000, text: "[inaudible ~01:03]", failed: true }];
    expect(toPlainText(withFailure)).not.toContain("inaudible");
  });
});
```

- [ ] **Step 2: Run it, watch it fail, write `src/server/captions.ts`, watch it pass**

Run: `npx vitest run tests/captions.test.ts`

- [ ] **Step 3: The route and the controls**

The route sets `Content-Disposition: attachment` with a filename built from the session's title through the existing `sanitiseFilename` in `src/web/summary-export.js`, moved to a shared module if it is needed on both sides. Reuse, do not duplicate it.

`src/web/summary-export.js` currently exports the summary only. Add a second row of controls under the transcript pane offering Text, SRT and VTT, each following the same disabled-with-a-reason contract. A session with no lines says "This session has no transcript to export."

- [ ] **Step 4: PDF without a dependency**

"Save as PDF" opens a print view of the current session, transcript and summary, styled by an added `@media print` block in `src/web/styles.css`, and calls `window.print()`. The browser's own PDF export does the rest. This is deliberate: a PDF library would be the largest dependency in the project, for a job every browser already does. Say so in the README rather than leaving it looking like a shortcut.

The print stylesheet hides the drawer, the controls and the audio element, sets black on white, and prints the timestamps.

- [ ] **Step 5: Document the exports**

Extend the README's "Exporting a summary" section into "Exporting", covering all formats, and say plainly which ones include the timestamps.

- [ ] **Step 6: Run everything and commit**

```bash
npm test && npm run typecheck
git add -A
git commit -m "Export the transcript as text, SRT, VTT and PDF"
git push origin HEAD
```

---

## Self-review

**Coverage against the six tier 1 items:**

| Item | Task |
| --- | --- |
| Click a line, hear it | 2, on the foundation from 1 |
| A term list that actually binds | 3 |
| One key to flag a moment | 4 |
| Edit a line, and re-transcribe on demand | 5 |
| Persist the session to disk | 6 |
| SRT, VTT, PDF and plain text | 7 |

**Deliberate scope cuts, both to be reported rather than quietly dropped:**
- Seeding a term list from a syllabus PDF with Claude. It needs a file upload route and a PDF parser, and this plan allows no new dependencies. Task 3 ships the manual list, which is what actually binds; the seeding is a convenience on top.
- Full-lecture re-transcription in one request. Physically impossible against a 25 MB upload cap at 1.92 MB per minute. Task 5 windows it instead, and the README is corrected.

**Type consistency:** `TranscriptLine` gains only `edited?: boolean` and is used unchanged by Tasks 1, 2, 5 and 7. `TranscriptFlag` is defined in Task 1 and consumed by Task 4. `joinWavs` and `windowsByByteBudget` are defined in Task 2 and consumed by Task 5. `promptPrefix` and `correct` are defined in Task 3 and consumed by Tasks 3 and 5.

**Ordering:** Task 1 is a hard prerequisite for everything. Tasks 2, 3 and 4 can then run in any order. Task 5 needs 1, 2 and 3. Task 6 needs 1. Task 7 needs 1.
