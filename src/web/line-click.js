/**
 * A transcript line answers to two gestures that share their first click:
 * one click plays the chunk, two clicks open the line for correction. Without
 * arbitration the browser delivers both clicks of a double-click before
 * `dblclick` ever fires, so the first click starts the audio, the second
 * clicks the line that is now playing and toggles it off, and the still
 * pending play() promise rejects with an AbortError. The reader gets
 * "Could not play that chunk" every single time they correct a line of a
 * session that has audio, which is the common case.
 *
 * The fix is to hold the play back for one double-click interval, but only
 * where a double-click can mean anything. While a recording is running the
 * line cannot be corrected at all (the route 409s it), so there is nothing to
 * disambiguate and playback stays instant, which is the whole point of the
 * feature during a lecture.
 */

/** Roughly the platform double-click threshold. Long enough that a deliberate
 *  double-click lands inside it, short enough that a single click still feels
 *  like a direct response. */
export const DOUBLE_CLICK_GRACE_MS = 250;

export function createLineActivator({ play, shouldDelay, delayMs = DOUBLE_CLICK_GRACE_MS }) {
  let pending = null;

  function cancel() {
    if (pending === null) return;
    clearTimeout(pending);
    pending = null;
  }

  function activate(...args) {
    cancel();
    if (!shouldDelay()) {
      play(...args);
      return;
    }
    pending = setTimeout(() => {
      pending = null;
      play(...args);
    }, delayMs);
  }

  return { activate, cancel, isPending: () => pending !== null };
}
