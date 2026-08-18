import { createRecorder } from "./audio/recorder.js";
import { createUploader } from "./upload.js";
import { createExportControls } from "./summary-export.js";

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

// What the export controls act on: whichever summary is displayed right now.
let displayedSummary = null; // { kind: "running", summary } | { kind: "markdown", markdown }
let displayedTitle = "Summary";
let recording = false;

const exportControls = createExportControls({
  root: document.getElementById("summary-actions"),
  getSummary: () => ({
    input: displayedSummary,
    title: displayedTitle,
    sessionId,
    recording,
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
// auto-scroll when the reader is already at the bottom.
transcriptEl.addEventListener("scroll", () => {
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

function renderSummary(summary) {
  displayedSummary = { kind: "running", summary };
  exportControls.refresh();

  const sections = [
    ["Topics", summary.topics],
    ["Key points", summary.keyPoints],
    ["Flagged", summary.flagged],
    ["Open questions", summary.openQuestions],
  ];

  summaryEl.replaceChildren();

  for (const [title, items] of sections) {
    if (!items.length) continue;
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

  if (summary.definitions.length) {
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

function setStatus(text) {
  statusEl.textContent = text;
}

async function start() {
  const created = await fetch("/api/sessions", { method: "POST" });
  sessionId = (await created.json()).id;

  events = new EventSource(`/api/sessions/${sessionId}/events`);
  // This handler sits next to the capture path: a malformed or unexpected
  // event must never be able to throw and take the page down mid-lecture.
  events.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data);
      if (event.type === "transcript") appendLine(event.line);
      if (event.type === "summary") renderSummary(event.summary);
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

  recording = true;
  displayedTitle = `Scribe ${new Date().toLocaleDateString()}`;
  exportControls.refresh();

  startedAt = Date.now();
  timerHandle = setInterval(() => {
    timerEl.textContent = formatElapsed(Date.now() - startedAt);
  }, 1000);

  recordButton.textContent = "Stop recording";
  recordButton.dataset.state = "recording";
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

  // If the final summary failed, markdown is empty: leave displayedSummary at
  // whatever the last running summary was, rather than overwriting it with
  // nothing. exportState() then falls back to that, or to the honest "the
  // summary failed" message if there was never a running summary either.
  if (markdown) {
    displayedSummary = { kind: "markdown", markdown };
    const done = document.createElement("pre");
    done.className = "final";
    done.textContent = markdown;
    summaryEl.replaceChildren(done);
  }
  exportControls.refresh();

  events.close();
  setStatus(`Saved to sessions/${sessionId}`);
  recordButton.textContent = "Start recording";
  recordButton.dataset.state = "idle";
  recordButton.disabled = false;
}

recordButton.addEventListener("click", () => {
  const action = recordButton.dataset.state === "recording" ? stop : start;
  action().catch((error) => {
    console.error(error);
    setStatus(`Something went wrong: ${error.message}`);
    recordButton.disabled = false;
  });
});
