import { createRecorder } from "./audio/recorder.js";
import { createUploader } from "./upload.js";
import { createExportControls } from "./summary-export.js";
import { createHistory } from "./history.js";

const recordButton = document.getElementById("record");
const transcriptEl = document.getElementById("transcript");
const summaryEl = document.getElementById("summary");
const statusEl = document.getElementById("status");
const timerEl = document.getElementById("timer");
const jumpButton = document.getElementById("jump");

let recorder = null;
let uploader = null;
let events = null;
let sessionId = null;
let startedAt = null;
let timerHandle = null;
let pinnedToLive = true;

let recording = false;
// True once a session has actually begun in this page load. Distinguishes
// "nothing has happened yet" (page load: stay quiet, the summary pane's own
// placeholder already explains the wait) from "a session ran and produced no
// summary" (say so). Never true before start() runs, never reset to false
// except when a start() attempt itself fails, in which case no session ever
// really began.
let started = false;

// Either "live" or `session:<id>`. The panes take their data from the source
// passed to render(), never from module state, so a third mode later is an
// addition rather than a restructuring.
let viewMode = "live";

/**
 * The live recording's own copy of what it has produced. SSE events always
 * update this, whether or not it is on screen, so a recording that continued
 * while the user read a past session is intact when they come back to it.
 *
 * `recording` and `started` are read through rather than copied: they are the
 * live view's export state by definition, and they change while this object
 * sits in `displayedSource`.
 */
const liveSource = {
  lines: [],
  summary: null, // { kind: "running", summary } | { kind: "markdown", markdown }
  title: null,
  get sessionId() {
    return sessionId;
  },
  get recording() {
    return recording;
  },
  get started() {
    return started;
  },
};

/** Whatever the panes are showing. Never read module state to decide this. */
let displayedSource = liveSource;

const exportControls = createExportControls({
  root: document.getElementById("summary-actions"),
  // The export controls act on the view, not on the recording: a past session
  // with no summary at all has to say so ("started", not "recording"), rather
  // than falling into the silent page-load state.
  getSummary: () => ({
    input: displayedSource.summary,
    title: displayedSource.title ?? "Summary",
    sessionId: displayedSource.sessionId,
    recording: displayedSource.recording,
    started: displayedSource.started,
  }),
  setStatus,
});

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

// Reading back a definition while the lecture continues is normal, so only
// auto-scroll when the reader is already at the bottom. "Jump to live" means
// nothing in a past session, so the pinning only tracks in the live view.
transcriptEl.addEventListener("scroll", () => {
  if (viewMode !== "live") return;
  const distanceFromBottom =
    transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
  pinnedToLive = distanceFromBottom < 40;
  jumpButton.hidden = pinnedToLive;
});

jumpButton.addEventListener("click", () => {
  pinnedToLive = true;
  jumpButton.hidden = true;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
});

function appendLine(line) {
  const el = document.createElement("p");
  el.className = line.failed ? "line line--failed" : "line";
  const stamp = document.createElement("span");
  stamp.className = "line__time";
  stamp.textContent = formatElapsed(line.startMs);
  el.append(stamp, document.createTextNode(line.text));
  transcriptEl.append(el);
  if (pinnedToLive) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function renderTranscript(lines) {
  transcriptEl.replaceChildren();
  for (const line of lines) appendLine(line);
}

function renderSummary(summary) {
  const sections = [
    ["Topics", summary.topics],
    ["Key points", summary.keyPoints],
    ["Flagged", summary.flagged],
    ["Open questions", summary.openQuestions],
  ];

  summaryEl.replaceChildren();

  for (const [title, items] of sections) {
    if (!items?.length) continue;
    const heading = document.createElement("h3");
    heading.textContent = title;
    const list = document.createElement("ul");
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item;
      list.append(li);
    }
    summaryEl.append(heading, list);
  }

  if (summary.definitions?.length) {
    const heading = document.createElement("h3");
    heading.textContent = "Definitions";
    const list = document.createElement("dl");
    for (const { term, definition } of summary.definitions) {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = definition;
      list.append(dt, dd);
    }
    summaryEl.append(heading, list);
  }
}

function renderFinal(markdown) {
  const done = document.createElement("pre");
  done.className = "final";
  done.textContent = markdown;
  summaryEl.replaceChildren(done);
}

/** A past session with nothing in it is finished, so it must not promise a
 *  summary in five minutes the way the live pane does. */
function renderEmptySummary(mode) {
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent =
    mode === "live"
      ? "The first summary appears after about five minutes."
      : "This session has no summary.";
  summaryEl.replaceChildren(empty);
}

function renderSummaryPane(mode, summary) {
  if (summary?.kind === "running") renderSummary(summary.summary);
  else if (summary?.kind === "markdown") renderFinal(summary.markdown);
  else renderEmptySummary(mode);
}

/** The one place the panes are filled. Mode and source in, DOM out. */
function render(mode, source) {
  viewMode = mode;
  displayedSource = source;

  // A past session opens at its beginning and has nothing to jump to; the live
  // view snaps back to the newest line.
  pinnedToLive = mode === "live";
  jumpButton.hidden = true;

  renderTranscript(source.lines);
  if (!pinnedToLive) transcriptEl.scrollTop = 0;

  renderSummaryPane(mode, source.summary);

  document.body.dataset.view = mode;
  exportControls.refresh();
}

function setStatus(text) {
  statusEl.textContent = text;
}

/** The inverse of Transcript.toMarkdown(): "[MM:SS] text", blank-line separated. */
function parseTranscript(markdown) {
  const lines = [];
  for (const block of String(markdown ?? "").split("\n")) {
    // Minutes are padded to two digits but not capped at two: a two-hour
    // lecture writes [120:00], and a fixed \d{2} would drop the whole tail.
    const match = /^\[(\d{2,}):(\d{2})\]\s(.*)$/.exec(block);
    if (!match) continue;
    const startMs = (Number(match[1]) * 60 + Number(match[2])) * 1000;
    lines.push({
      index: lines.length,
      startMs,
      endMs: startMs,
      text: match[3],
      failed: match[3].startsWith("[inaudible"),
    });
  }
  return lines;
}

// Named `drawer` rather than `history`: a module-level `history` shadows the
// global History API, and a later edit reaching for it would get this instead.
const drawer = createHistory({
  root: document.getElementById("history"),
  toggle: document.getElementById("sidebar-toggle"),
  setStatus,
  // The whole reading-while-recording restriction, on this side too: one
  // predicate, one place to change when the restriction is lifted.
  canOpen: () => !recording,
  onOpen: (session) => {
    render(`session:${session.id}`, {
      lines: parseTranscript(session.transcript),
      summary: session.summaryMarkdown
        ? { kind: "markdown", markdown: session.summaryMarkdown }
        : session.runningSummary
          ? { kind: "running", summary: session.runningSummary }
          : null,
      title: session.title,
      sessionId: session.id,
      // A session on disk always ran, so "no summary" here is a failure worth
      // naming rather than the silence of a page that has done nothing yet.
      recording: false,
      started: true,
    });
    setStatus(`Reading ${session.title}`);
  },
  onLive: () => {
    render("live", liveSource);
    setStatus("");
  },
});

/** A drawer that failed to repaint must not overwrite the recording's own
 *  status line, so this one only reports to the console. */
function refreshLibrary() {
  drawer.refresh().catch((error) => console.error("[scribe] library refresh failed", error));
}

drawer.refresh().catch((error) => setStatus(`Could not load the library: ${error.message}`));
document.getElementById("scrim").addEventListener("click", () => drawer.close());

async function start() {
  // A stale final summary from a previous session in the same page load must
  // not stay exportable once a new recording begins. `recording` and
  // `started` flip here too, so the disabled reason reads "first summary in
  // five minutes" for the whole gap before mic permission resolves, not the
  // stale "failed" (or, on the very first recording, the page-load silence).
  liveSource.summary = null;
  recording = true;
  started = true;

  // Recording always happens in the live view. If the user was reading a past
  // session, the panes come back before anything streams into them.
  render("live", liveSource);
  drawer.clearOpen();
  setStatus("");

  const created = await fetch("/api/sessions", { method: "POST" });
  sessionId = (await created.json()).id;

  events = new EventSource(`/api/sessions/${sessionId}/events`);
  // This handler sits next to the capture path: a malformed or unexpected
  // event must never be able to throw and take the page down mid-lecture.
  // It always updates liveSource, and only touches the DOM in the live view.
  events.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data);
      if (event.type === "transcript") {
        liveSource.lines.push(event.line);
        if (viewMode === "live") appendLine(event.line);
      }
      if (event.type === "summary") {
        liveSource.summary = { kind: "running", summary: event.summary };
        if (viewMode === "live") {
          renderSummary(event.summary);
          exportControls.refresh();
        }
      }
      if (event.type === "status" && event.failedChunks > 0) {
        setStatus(`${event.failedChunks} chunk(s) failed, audio kept`);
      }
    } catch (error) {
      console.error("[scribe] failed to handle server event", error);
    }
  };

  uploader = createUploader({
    sessionId,
    onStatus: ({ queued, dropped }) => {
      if (dropped > 0) setStatus(`${dropped} chunk(s) dropped, server unreachable`);
      else if (queued > 1) setStatus(`${queued} chunks waiting to upload`);
      else setStatus("");
    },
  });

  recorder = createRecorder({ onChunk: (chunk) => uploader.enqueue(chunk) });
  await recorder.start();

  liveSource.title = `Scribe ${new Date().toLocaleDateString()}`;
  exportControls.refresh();

  startedAt = Date.now();
  timerHandle = setInterval(() => {
    timerEl.textContent = formatElapsed(Date.now() - startedAt);
  }, 1000);

  recordButton.textContent = "Stop recording";
  recordButton.dataset.state = "recording";

  // The new session is live now, so the drawer should say so.
  refreshLibrary();
}

async function stop() {
  recordButton.disabled = true;
  recordButton.textContent = "Finishing…";

  clearInterval(timerHandle);
  await recorder.stop();
  await uploader.drain();

  setStatus("Writing the summary…");
  const response = await fetch(`/api/sessions/${sessionId}/stop`, { method: "POST" });
  const { markdown } = await response.json();

  recording = false;

  // If the final summary failed, markdown is empty: leave the live summary at
  // whatever the last running summary was, rather than overwriting it with
  // nothing. exportState() then falls back to that, or to the honest "the
  // summary failed" message if there was never a running summary either.
  if (markdown) {
    liveSource.summary = { kind: "markdown", markdown };
    if (viewMode === "live") renderFinal(markdown);
  }
  exportControls.refresh();

  events.close();
  setStatus(`Saved to sessions/${sessionId}`);
  recordButton.textContent = "Start recording";
  recordButton.dataset.state = "idle";
  recordButton.disabled = false;

  // The finished session picks up its duration and drops its live marker.
  refreshLibrary();
}

recordButton.addEventListener("click", () => {
  const wasStarting = recordButton.dataset.state !== "recording";
  const action = wasStarting ? start : stop;
  action().catch((error) => {
    console.error(error);
    setStatus(`Something went wrong: ${error.message}`);
    recordButton.disabled = false;
    // start() flips `recording` and `started` before mic permission is even
    // resolved, so a rejected start() (permission denied, session creation
    // failed, ...) must flip both back rather than leaving the export
    // controls stuck reading "recording", or later "failed", for a session
    // that never actually began.
    if (wasStarting && (recording || started)) {
      recording = false;
      started = false;
      exportControls.refresh();
    }
  });
});
