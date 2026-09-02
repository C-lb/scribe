# Scribe

Scribe is a localhost web app that records a lecture from your microphone, transcribes it in roughly 20-second chunks through Groq's Whisper API, and keeps a running Claude-written summary next to the live transcript as it goes. When you stop recording, it writes a full Markdown revision document from the whole transcript.

For how the recording and transcription pipeline actually works, in plain language, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Setup

Requires Node 20 or later.

```bash
npm install
cp .env.example .env
```

Fill in both keys in `.env`:

- `GROQ_API_KEY`: used for speech-to-text.
- `ANTHROPIC_API_KEY`: used for the running and final summaries.

`.env` is listed in `.gitignore` and must never be committed.

## Running

```bash
npm run dev
```

The server binds `127.0.0.1` only, and it refuses any state-changing request that a browser reports as coming from another site, so a page in another tab cannot stop your recording or open Finder windows behind your back.

Open `http://localhost:4747`, grant microphone access, and press "Start recording". Speak normally; the transcript fills in a line at a time and the summary pane updates every few minutes. Press "Stop recording" to end the session and write the final notes.

## Course term lists

The "Course" picker in the header binds a category's term list into the recording you are about to start: it goes in front of Whisper's bias prompt on every chunk, and it corrects the transcript text that comes back before that text ever gets written down. This is what fixes the drift described under "Known limitations" below, where a mistranscription used to enter the bias prompt's own tail and compound for the rest of the lecture.

The correction is two-tier and deliberately conservative:

1. **Exact match, case-insensitive.** "raft" becomes "Raft".
2. **One letter of difference, gated four ways.** The word has to clear all four: the term is four characters or more, the word is not already an exact match for some other term, the word's first letter matches the term's, and the word's length differs from the term's by exactly one. That last gate means only an inserted or deleted letter qualifies, never a substitution of the same length. "RAF" becomes "Raft", because a letter is missing; "daft" does not, because it is the same length and is far more likely to be a different real word than a mishearing, and neither does "rapt".

The choice is fixed once a recording starts: switching mid-lecture would mean the bias prompt on chunk 40 was built from a different vocabulary than chunk 1, which is confusing to debug and does not obviously help. Pick the course before pressing "Start recording".

**Editing a term list.** Right-click a category heading in the drawer and choose "Edit terms" to open a one-term-per-line editor. Cmd/Ctrl+Enter or clicking away saves it; Escape cancels. The list is capped at 100 terms of 60 characters each, which is generous for a course's worth of proper nouns and jargon and small enough that nobody pastes in a textbook by accident.

**Known gap: no automatic seeding from a syllabus.** Populating a term list from an uploaded document with Claude was out of scope for this pass. It would need a file upload path and a way to extract text from a PDF, and neither was worth adding as a new dependency for this task. Term lists are typed in by hand for now.

## Working with the transcript

**Click a line to hear it.** Every line of a session recorded with `SCRIBE_KEEP_AUDIO` on plays the exact chunk it was transcribed from, so a line that reads wrong can be checked against what was actually said. Click once to play, click the same line again to stop it. Shift-click plays continuously from that line on, rolling into each following line as the chunk ends, which is how you listen to a passage rather than a sentence. The line being played is marked while it plays. Keyboard: Tab to a line and press Enter or Space, and hold Shift for the same continuous play.

A session recorded with `SCRIBE_KEEP_AUDIO=false` has nothing to play, and the reason line under the transcript says so rather than leaving the lines looking clickable.

**Double-click a line to correct it.** Type the correction and press Enter, or Escape to abandon it; clicking away also abandons. This is the same gesture as renaming a session in the drawer. A corrected line is saved to both `transcript.md` and `transcript.json` and shows a quieter timestamp with the title "Corrected by hand". Correcting is only possible once the recording has stopped: while a lecture is running the live transcript is rewritten in full on every chunk, so an edit would be silently overwritten, and the server refuses it with "Stop recording before correcting a line".

Because playing and correcting share the first click, on a session that is not recording a click waits about a quarter of a second to see whether a second one is coming. During a recording there is nothing to wait for (no line can be corrected), so playback there is instant.

**Press "f" to flag a moment.** While a lecture is recording, the "Flag" button beside the record button, and the `f` key as its shortcut, mark the moment you are in right now: the thing worth coming back to, the point the lecturer said would be on the exam. The status line confirms with "Flagged at 01:03", because a keypress with no answer is a dead key. The key is ignored while you are typing in a field or a menu, so naming a session never drops a flag by accident.

A flag is a timestamp. It is attached to whichever transcript line covers that moment, which is usually a line that has not come back from Whisper yet, so it is filled in as soon as that chunk lands. Flagged lines are marked in the transcript pane, the flags are saved in `transcript.json`, and the final document gets a "Marked in the room" section listing each one with its timestamp and what was being said at the time. That section is appended after the model has written its notes rather than asked for in the prompt: the flags are ground truth from the person in the room, and a model handed them as prose might paraphrase or drop one.

## The sessions drawer

Every recording Scribe has ever made is listed in the drawer on the left. The button in the header opens and closes it, and it remembers which way you left it across reloads. A session with no name of its own shows its date, like "18 August 2026, 17:03".

- **Reading a past session.** Click a row to load its saved transcript and summary into the panes. This only works while nothing is recording: the transcript pane belongs to the live lecture, so during a recording the status line says "Stop recording to read past sessions" instead. The row for a running recording is marked "Recording" and clicking it takes you back to the live view.
- **Renaming.** Double-click a row, or right-click it and choose Rename. Type the new name and press Enter, or Escape to abandon it. Clearing the name entirely puts the date back.
- **Categories.** "New category" adds a heading and drops you straight into naming it. Drag a row onto a heading to file it there, or right-click a row and pick "Move to". Headings rename the same way rows do, and right-clicking one offers "Delete category", which takes two clicks to confirm. Deleting a heading never touches a recording: its sessions fall back to Uncategorised. Right-click a heading and choose "Edit terms" to set the vocabulary a course's recordings bind into transcription; see "Course term lists" above.
- **Reveal in Finder.** Right-click a row and choose it to open that session's folder.
- **Restore library.** The names and categories live in `sessions/library.json`, separately from the recordings. Scribe copies that file when it starts, and "Restore library" puts the copy back, so an organising session that went wrong can be undone. It also takes two clicks. Restoring only reaches back to when Scribe was opened; the copies it replaces are kept under `sessions/.library-backups/archive/` if you need an older one by hand.

Nothing in the drawer can delete a recording. The organisation file is the only thing it writes, and losing it would lose names and grouping, never audio or a transcript.

## Exporting

Both panes are live for whatever is on screen, whether that is a recording in progress or a past session opened from the drawer. Every export reflects the transcript as it stands right now, including any corrections made through double-clicking a line.

**The summary**, above the summary pane:

- **Copy** puts the summary on the clipboard as plain text, ready to paste into a chat window or a notes app.
- **Save** downloads it as a Markdown file named after the session, like `18-august-2026-1703.md`.
- **Share** hands it to the operating system's own share sheet, and only appears in browsers that have one.

**The transcript**, above the transcript pane:

- **Text** downloads it as plain text, one paragraph per line, no timestamps.
- **SRT** and **VTT** download it as caption files, one cue per line, numbered from one regardless of any gaps left by a dropped chunk. Cue timing carries the real start and end of each chunk. SRT and VTT are the only two formats here that carry timestamps at all.

A line the model failed to transcribe is never written into any of these three: the `[inaudible ~MM:SS]` placeholder is a note to you, not something that was actually said, so it would misrepresent the recording if it showed up in a caption file or a plain-text export.

**Save as PDF**, next to the summary's own buttons, opens the browser's print dialog on the current session (transcript and summary both) instead of downloading anything itself; choose "Save as PDF" there. This is deliberate rather than a shortcut: a PDF-generation library would have been the single largest dependency in this project, for output every browser already knows how to produce from a styled page. The print view (a `@media print` stylesheet) hides the drawer, every button and reason line, and the audio player, and prints the transcript's timestamps in black on white.

A control that cannot do anything yet says why, in a line under the buttons rather than only in a tooltip. For a past session whose summary failed, or whose transcript has no lines at all, the reason line says so. During a recording with nothing to export yet it says nothing, because the pane right below it is already saying the first summary appears after about five minutes, and printing that twice reads as a fault rather than as patience.

## Where sessions are written

Each recording gets its own directory under `~/scribe/sessions/<timestamp>/` (override with `SCRIBE_SESSIONS_DIR`):

- `transcript.md`: every transcribed line with its timestamp. It's rewritten in full on each flush rather than appended; see "Known limitations" for why.
- `summary.md`: the final Markdown revision notes, written once when you stop recording.
- `meta.json`: session id, total audio seconds, failed-chunk count, the two model names, and an estimated Groq cost. Never contains an API key.
- `audio/NNNN.wav`: the raw audio for each chunk, kept so a full re-transcription is always possible, and what a click on a transcript line plays back. Only written if `SCRIBE_KEEP_AUDIO` is true. `audio/full.wav` is the whole lecture joined into one file, written when you stop recording.
- `transcript.json`: the same lines with their real chunk index, start and end in milliseconds, whether the chunk failed, whether a human has corrected the line, and the flags. This is the file the app reads back; `transcript.md` is for you. A session recorded before this file existed still opens: the Markdown is parsed instead, though it carries no flags and numbers the lines by position.
- `session.json`: whether this session is still recording, plus the counters needed to pick it up again after a restart. Never contains an API key.
- `running-summary.json`: the most recent running summary, so a restart carries on accumulating rather than starting the summary over.

## Configuration

All of these live in `.env`, with defaults from `.env.example`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GROQ_API_KEY` | (required) | Groq API key, used for Whisper transcription. |
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key, used for summarisation. |
| `SCRIBE_CHUNK_SECONDS` | `20` | Target length of each audio chunk before it's sent for transcription. |
| `SCRIBE_SUMMARY_INTERVAL_MINUTES` | `5` | How often the running summary is regenerated. |
| `SCRIBE_RUNNING_MODEL` | `claude-opus-5` | Model used for the running (in-progress) summary. |
| `SCRIBE_FINAL_MODEL` | `claude-opus-5` | Model used for the final Markdown notes. |
| `SCRIBE_KEEP_AUDIO` | `true` | Whether to keep the per-chunk WAV files on disk. |
| `SCRIBE_LANGUAGE` | `en` | Language hint passed to Whisper. |
| `SCRIBE_PORT` | `4747` | Port the server listens on. |
| `SCRIBE_SESSIONS_DIR` | `~/scribe/sessions` | Where session directories are written. The test suites override this; leave it unset for normal use. |
| `SCRIBE_OBSIDIAN_VAULT` | (unset) | Folder inside an Obsidian vault that finished sessions are mirrored into. Unset turns the export off. |

## Obsidian

With `SCRIBE_OBSIDIAN_VAULT` pointing at a folder inside a vault (say `~/Vault/Resources/Scribe`), every session that finishes writes itself there as a note: one folder per library category, one `.md` per session, `Uncategorised/` for anything unfiled.

```
Resources/Scribe/
  BUSI 520/
    Week 3 - cash flows.md
  Uncategorised/
    25 August 2026, 12-04.md
```

The note opens with YAML frontmatter (`scribe_id`, `title`, `category`, `date`, `duration`, `tags: [scribe]`), then the summary, then the timestamped transcript. Characters Obsidian or the filesystem refuse — `/ : # ^ [ ] | * ? " < >` — become hyphens in the filename, so `12:04` reads as `12-04`; the title inside the note keeps the colon.

The vault is a projection and never a source of truth. Nothing is read back out of it, and a vault that is missing or on an unmounted disk is a line in the log, never a failed recording or a failed rename.

Renaming a session, refiling it, renaming a category or deleting one moves the note to match. The note it should move is found by reading `scribe_id` out of the frontmatter of every note under the Scribe root, rather than by remembering the last path written: `library.json` is disposable by design, and a remembered path lost with it would orphan the note and then duplicate it. Notes you wrote yourself are left alone, because they have no `scribe_id`.

Hiding a session leaves its note where it is, the same way it leaves the session folder alone.

**Export to Obsidian** in a session's right-click menu writes the note on demand — for the sessions recorded before the vault was configured, and for a lecture that ended while the vault was unreachable. It names the file it wrote in the status line.

## Tests

```bash
npm test              # unit tests, live suites skipped
npm run typecheck      # tsc, no emit
SCRIBE_LIVE_TESTS=1 npm test   # also runs the live Groq and Claude suites
```

The live suites make real API calls and spend real money (a few cents at most per run). Run them deliberately, not as part of a normal test loop.

**A note on the model used during verification.** The default for both `SCRIBE_RUNNING_MODEL` and `SCRIBE_FINAL_MODEL` is `claude-opus-5`, and that stays the default in code. Claude Opus 5 was intermittently overloaded during Task 11's verification pass, so the summary-cycle and prompt-cache checks were run with `SCRIBE_RUNNING_MODEL=claude-sonnet-5` instead of waiting on Opus. Prompt caching is a prefix-match mechanism and is model-independent, so a Sonnet run proves the caching invariant just as well as an Opus run would. This was a verification-time substitution only; nothing in the default configuration changed.

## Known limitations

**Latency floor of roughly 20-25 seconds.** Groq's speech-to-text API is batch, not streaming: you send a complete audio file and get a complete transcript back. There's no way to get a partial transcript mid-chunk. So the first line of transcript can only appear once the first chunk (sized by `SCRIBE_CHUNK_SECONDS`, default 20s) has finished recording and made a round trip to Groq. Making the chunk shorter would lower this floor but increase the number of API calls and the chance of cutting a word in half.

**Chunked transcription is less accurate than one long file.** Whisper does better with more context: a single 90-minute file gives it the whole lecture's vocabulary and phrasing to lean on, where a 20-second chunk only has the trailing transcript text passed as a bias prompt. This is a deliberate trade for low latency. Because the raw audio is kept on disk (`audio/NNNN.wav`, unless `SCRIBE_KEEP_AUDIO=false`), a full, more accurate re-transcription from the concatenated audio is always technically possible after the fact, the same way it would be for any recording you have the file for. Scribe does not do this for you, and it could not do it as one request even if it tried: Groq caps uploads at 25 MB, and Scribe's 16 kHz mono 16-bit audio runs about 1.92 MB per minute, so a 90-minute lecture is roughly 172 MB, well past the limit. A real re-transcription would mean re-chunking and re-running the whole lecture through Groq by hand, outside the app. The live transcript is optimised for immediacy, not for being the final word.

This is not theoretical. It was observed directly during verification. A synthesised lecture on the Raft consensus protocol was transcribed correctly as "Raft" in the first two chunks, then drifted to "raft" (chunk 3), then to "RAF" for every chunk from the fifth on ("makes RAF tolerant of network partitions", "RAF avoids this by using the term number", "RAF gives you a practical way..."). The 200-character trailing-transcript bias prompt passed to Whisper reduces this kind of drift but clearly does not prevent it once a mistranscription has entered the prompt's own tail. A reader using the live transcript to revise from should treat unfamiliar proper nouns and technical terms as provisional and check them against the kept audio, not take the live spelling as authoritative.

Scribe's own answer to this, in-app, is two-layered. A course term list (see "Course term lists" above) is the direct fix going forward: picking a course whose list includes "Raft" both biases Whisper toward it and corrects "RAF" back to "Raft" before it can enter the next chunk's prompt. It only helps for vocabulary you have actually typed in, though. For a line that is already wrong and not in any term list, double-click it in the transcript pane, type the correction, and press Enter, the same gesture as renaming a session in the drawer. That is a cheaper fix than a re-run and is available on any session that is not currently recording.

**No speaker diarisation.** The transcript doesn't distinguish who is speaking. A lecturer and a student asking a question both show up as plain text with no speaker label.

**Microphone only.** Scribe captures whatever the browser's `getUserMedia` gives it from the selected microphone. It does not capture system audio: a Zoom call, a video, another app's playback. Screen and tab audio capture is out of scope.

**A restart mid-recording resumes, but the browser's own gap does not.** A `Session` keeps `session.json`, alongside `transcript.md` and `transcript.json`, up to date after every chunk, and again with `recording: false` once you stop it by hand. On boot, before the server starts listening, it scans the sessions directory for any `session.json` still marked `recording: true` and rebuilds the newest one from disk, so a chunk the browser sends right after the restart finds its session instead of a 404. Scribe records one lecture at a time, so an older session still marked live is a leftover from a crash rather than a second concurrent lecture: it is written back as `recording: false` and logged, which is what stops a single crash leaving a row that reads "Recording" forever and can never be opened, hidden or corrected. What is still lost is whatever the browser's own upload queue dropped while the server was down: that queue is bounded, so if the server is down for longer than the queue can hold, the oldest queued chunks are gone for good, and the recording resumes with a gap rather than a stall.

## What still needs a human with a microphone

The checks below need a real person talking into a real microphone; they could not be run automatically in this environment. Chromium's `--use-fake-device-for-media-capture` flag did not take effect in the sandbox this was tested in: `getUserMedia` kept returning the real hardware microphone instead of the supplied WAV file, confirmed by device labels and by capture amplitude that varied between runs instead of replaying a fixed file.

- **Browser capture end to end.** The full path from a real `getUserMedia` mic stream through the AudioWorklet, downsampler, and silence-point chunker, running live in a browser tab for 90+ seconds. The server-side pipeline (chunk upload → Groq → transcript → summary → SSE → DOM) was verified directly by posting real synthesised-speech audio chunks straight to the API, which proves the server half but not the capture half.
- **The UI's auto-scroll behaviour.** Scrolling up during a live recording to confirm "Jump to live" appears and works, per Step 3.4 of the original task brief.
- **A live "kill the server mid-recording" test against a real browser tab.** The reasoning in Session.ingestChunk and the uploader's queue/drop logic were read and are sound, but watching an actual recording tab survive a server restart, with the status line reporting queued or dropped chunks, has not been observed first-hand.
