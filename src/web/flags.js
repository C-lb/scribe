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
