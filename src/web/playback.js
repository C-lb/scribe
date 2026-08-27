/**
 * Owns one <audio> element and nothing else: no DOM beyond that element, no
 * knowledge of which row is on screen. app.js turns `onState` into a CSS
 * class; this module only ever knows an index, not a node.
 */

function chunkUrl(sessionId, index) {
  return `/api/sessions/${sessionId}/audio/${index}`;
}

export function createPlayback({ audioEl, onState }) {
  // The current line list, so continuous play can find the next REAL index
  // rather than assuming `index + 1`. A dropped silence artefact (see
  // hallucination.ts) leaves a gap in the chunk indexes, and index + 1 would
  // either play nothing or play the wrong chunk.
  let lines = [];
  let sessionId = null;
  let playingIndex = null;
  let continuous = false;

  function report() {
    onState({ playingIndex, continuous });
  }

  /**
   * One listener, added with `once` so it removes itself the moment a chunk
   * finishes. Re-adding the same function reference on the next chunk is a
   * no-op per the DOM spec when a matching listener is still registered, so
   * jumping to a new line before the current chunk ends never piles up
   * duplicate handlers.
   */
  function onEnded() {
    if (!continuous) return;
    const at = lines.findIndex((line) => line.index === playingIndex);
    const next = at >= 0 ? lines[at + 1] : undefined;
    if (!next) {
      stop();
      return;
    }
    void playChunk(sessionId, next.index, true);
  }

  async function playChunk(id, index, isContinuous) {
    sessionId = id;
    playingIndex = index;
    continuous = isContinuous;
    audioEl.src = chunkUrl(id, index);
    audioEl.addEventListener("ended", onEnded, { once: true });
    report();
    await audioEl.play();
  }

  function stop() {
    audioEl.pause();
    playingIndex = null;
    continuous = false;
    report();
  }

  /** Clicking the line already playing is how you stop it: no second control
   *  to learn, and it matches how the record button itself toggles. */
  async function playLine(id, line, { continuous: isContinuous = false } = {}) {
    if (sessionId === id && playingIndex === line.index) {
      stop();
      return;
    }
    await playChunk(id, line.index, isContinuous);
  }

  return {
    playLine,
    stop,
    setLines: (newLines) => {
      lines = newLines;
    },
    state: () => ({ playingIndex, continuous }),
  };
}
