/**
 * One key, no typing, no modal: the only interaction a listener can afford
 * mid-sentence. Every press gets a visible response on both the confirming
 * and the failing path -- a keypress that silently does nothing is the exact
 * failure this feature cannot have.
 */

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function createFlags({ post, elapsedMs, setStatus }) {
  async function mark() {
    const atMs = elapsedMs();
    try {
      await post(atMs);
      setStatus(`Flagged at ${formatElapsed(atMs)}`);
    } catch (error) {
      setStatus(`Could not flag that moment: ${error.message}`);
    }
  }

  return { mark };
}

/**
 * True when focus is inside a control that owns the keys it is sent: a form
 * field, or a contenteditable region. `closest`, not a tag-name check on the
 * event target itself, so a target nested inside one of these -- an option
 * inside a select's own listbox, a span typed into a contenteditable -- is
 * still covered.
 */
export function isTypingTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable]"));
}

/**
 * Binds the one key this feature needs, kept independent of any real
 * keyboard event or DOM so it can be driven with a fake event object in a
 * test. `isRecording` is a function rather than a captured boolean because
 * the caller's recording state changes after this handler is created and
 * bound once for the life of the page.
 */
export function createFlagKey({ flags, isRecording }) {
  return function handleKeydown(event) {
    if (event.key.toLowerCase() !== "f") return;
    // Modifier keys are left alone, so Cmd/Ctrl+F for the browser's own find
    // still works even while a recording is running.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!isRecording()) return;
    // Anywhere focus could already be consuming the `f` keystroke for its
    // own purpose -- typing a session name, a select's own type-ahead --
    // must stay untouched, or a flag drops into the recording unintended.
    if (isTypingTarget(event.target)) return;

    event.preventDefault();
    flags.mark();
  };
}
