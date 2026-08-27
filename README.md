# Scribe

Scribe is a localhost web app that records a lecture from your microphone, transcribes it in roughly 20-second chunks through Groq's Whisper API, and keeps a running Claude-written summary next to the live transcript as it goes. When you stop recording, it writes a full Markdown revision document from the whole transcript.

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

Open `http://localhost:4747`, grant microphone access, and press "Start recording". Speak normally; the transcript fills in a line at a time and the summary pane updates every few minutes. Press "Stop recording" to end the session and write the final notes.

## Course term lists

The "Course" picker in the header binds a category's term list into the recording you are about to start: it goes in front of Whisper's bias prompt on every chunk, and it corrects the transcript text that comes back before that text ever gets written down. This is what fixes the drift described under "Known limitations" below, where a mistranscription used to enter the bias prompt's own tail and compound for the rest of the lecture.

The correction is two-tier and deliberately conservative:

1. **Exact match, case-insensitive.** "raft" becomes "Raft".
2. **One letter of difference, gated.** Only for terms of four characters or more, only for a word not already an exact match for some other term, and only when the word's first letter matches the term's. "RAF" becomes "Raft"; "daft" does not, even though it is also one substitution away, because Whisper's own drift clips or garbles the tail of a word far more often than the head.

The choice is fixed once a recording starts: switching mid-lecture would mean the bias prompt on chunk 40 was built from a different vocabulary than chunk 1, which is confusing to debug and does not obviously help. Pick the course before pressing "Start recording".

**Editing a term list.** Right-click a category heading in the drawer and choose "Edit terms" to open a one-term-per-line editor. Cmd/Ctrl+Enter or clicking away saves it; Escape cancels. The list is capped at 100 terms of 60 characters each, which is generous for a course's worth of proper nouns and jargon and small enough that nobody pastes in a textbook by accident.

**Known gap: no automatic seeding from a syllabus.** Populating a term list from an uploaded document with Claude was out of scope for this pass. It would need a file upload path and a way to extract text from a PDF, and neither was worth adding as a new dependency for this task. Term lists are typed in by hand for now.

## The sessions drawer

Every recording Scribe has ever made is listed in the drawer on the left. The button in the header opens and closes it, and it remembers which way you left it across reloads. A session with no name of its own shows its date, like "18 August 2026, 17:03".

- **Reading a past session.** Click a row to load its saved transcript and summary into the panes. This only works while nothing is recording: the transcript pane belongs to the live lecture, so during a recording the status line says "Stop recording to read past sessions" instead. The row for a running recording is marked "Recording" and clicking it takes you back to the live view.
- **Renaming.** Double-click a row, or right-click it and choose Rename. Type the new name and press Enter, or Escape to abandon it. Clearing the name entirely puts the date back.
- **Categories.** "New category" adds a heading and drops you straight into naming it. Drag a row onto a heading to file it there, or right-click a row and pick "Move to". Headings rename the same way rows do, and right-clicking one offers "Delete category", which takes two clicks to confirm. Deleting a heading never touches a recording: its sessions fall back to Uncategorised. Right-click a heading and choose "Edit terms" to set the vocabulary a course's recordings bind into transcription; see "Course term lists" above.
- **Reveal in Finder.** Right-click a row and choose it to open that session's folder.
- **Restore library.** The names and categories live in `sessions/library.json`, separately from the recordings. Scribe copies that file when it starts, and "Restore library" puts the copy back, so an organising session that went wrong can be undone. It also takes two clicks. Restoring only reaches back to when Scribe was opened; the copies it replaces are kept under `sessions/.library-backups/archive/` if you need an older one by hand.

Nothing in the drawer can delete a recording. The organisation file is the only thing it writes, and losing it would lose names and grouping, never audio or a transcript.

## Exporting a summary

Above the summary pane are three controls, live for whatever the pane is showing, whether that is the running summary of a recording in progress or a past session you have opened:

- **Copy** puts the summary on the clipboard as plain text, ready to paste into a chat window or a notes app.
- **Save** downloads it as a Markdown file named after the session, like `18-august-2026-1703.md`.
- **Share** hands it to the operating system's own share sheet, and only appears in browsers that have one.

A control that cannot do anything yet says why, in a line under the buttons rather than only in a tooltip. For a past session whose summary failed, it says so. During a recording with no summary yet it says nothing, because the pane right below it is already saying the first summary appears after about five minutes, and printing that twice reads as a fault rather than as patience.

## Where sessions are written

Each recording gets its own directory under `~/scribe/sessions/<timestamp>/` (override with `SCRIBE_SESSIONS_DIR`):

- `transcript.md`: every transcribed line with its timestamp. It's rewritten in full on each flush rather than appended; see "Known limitations" for why.
- `summary.md`: the final Markdown revision notes, written once when you stop recording.
- `meta.json`: session id, total audio seconds, failed-chunk count, the two model names, and an estimated Groq cost. Never contains an API key.
- `audio/NNNN.wav`: the raw audio for each chunk, kept so a full re-transcription is always possible. Only written if `SCRIBE_KEEP_AUDIO` is true.

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

**Sessions live in server memory only.** A `Session` object and its transcript state live in a `Map` inside the running Node process. If the server restarts mid-recording, that in-memory state is gone: the browser keeps capturing and queuing chunks (and shows a "queued" or "dropped" status), but any chunk it eventually sends to the restarted server gets a 404, because the new process has never heard of that session id. The audio already uploaded before the restart is not lost (it's on disk under the old session directory), but the recording cannot be resumed or completed automatically. For a single-user local tool this was judged not worth the complexity of persisting and rehydrating session state from disk.

## What still needs a human with a microphone

The checks below need a real person talking into a real microphone; they could not be run automatically in this environment. Chromium's `--use-fake-device-for-media-capture` flag did not take effect in the sandbox this was tested in: `getUserMedia` kept returning the real hardware microphone instead of the supplied WAV file, confirmed by device labels and by capture amplitude that varied between runs instead of replaying a fixed file.

- **Browser capture end to end.** The full path from a real `getUserMedia` mic stream through the AudioWorklet, downsampler, and silence-point chunker, running live in a browser tab for 90+ seconds. The server-side pipeline (chunk upload → Groq → transcript → summary → SSE → DOM) was verified directly by posting real synthesised-speech audio chunks straight to the API, which proves the server half but not the capture half.
- **The UI's auto-scroll behaviour.** Scrolling up during a live recording to confirm "Jump to live" appears and works, per Step 3.4 of the original task brief.
- **A live "kill the server mid-recording" test against a real browser tab.** The reasoning in Session.ingestChunk and the uploader's queue/drop logic were read and are sound, but watching an actual recording tab survive a server restart, with the status line reporting queued or dropped chunks, has not been observed first-hand.
