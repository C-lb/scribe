/**
 * Input level, and the silence policy built on top of it.
 *
 * Whisper does not return an empty string for silence. `whisper-large-v3-turbo`
 * was trained largely on captioned web video, so a segment with no speech in it
 * decodes to the highest-prior caption in that distribution: "Thank you.",
 * "Thanks for watching!", "[Music]". It arrives confident and well formed, and
 * `session.ts` then feeds it back as the next chunk's bias prompt, which raises
 * the odds of the same phrase again. The cheapest place to break that loop is
 * before the upload: a chunk with no speech in it is never sent at all.
 *
 * Everything here is pure so it can be tested without an AudioContext.
 */

/**
 * Root mean square of a frame, in the -1..1 sample domain.
 *
 * Empty input is 0 rather than NaN: callers treat the number as a level, and a
 * NaN would compare false against every threshold and quietly disable the gate.
 */
export function rms(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * The gate, at roughly -52 dBFS.
 *
 * Deliberately near-zero rather than merely quiet. The two errors are not
 * symmetrical: letting a quiet chunk through costs one API call and a possible
 * hallucination that the server-side backstop still catches, while gating a
 * real one deletes a piece of the lecture permanently. So this sits below room
 * tone and well below a lecturer thirty feet from the mic, and a chunk has to
 * be genuinely dead to be dropped.
 */
export const SILENCE_RMS = 0.0025;

export function isSilent(samples, threshold = SILENCE_RMS) {
  return rms(samples) < threshold;
}

/** Level as dBFS, floored at -100 so a digital-zero frame stays a finite number. */
export function toDbfs(level) {
  if (level <= 0) return -100;
  return Math.max(-100, 20 * Math.log10(level));
}

/**
 * A 0..1 position for a meter, mapped across a dBFS window rather than the raw
 * amplitude. Linear amplitude puts all of speech in the bottom tenth of the bar
 * and reads as broken.
 */
export function meterPosition(level, { floorDb = -60, ceilDb = -6 } = {}) {
  const db = toDbfs(level);
  const position = (db - floorDb) / (ceilDb - floorDb);
  return Math.min(1, Math.max(0, position));
}

/**
 * Tracks runs of silent chunks and reports the severity the UI should show.
 *
 * States, and why there are three:
 *  - "ok"      speech is arriving; say nothing.
 *  - "quiet"   this chunk had none. Normal in a pause, so it is an aside.
 *  - "silent"  `warnAfter` chunks in a row, roughly a minute at 20s chunks.
 *              At that length it is no longer a pause, and the likely causes
 *              (wrong input device, muted mic) are all things the user can fix
 *              while the lecture is still running.
 *
 * The tracker never stops anything. A run of silence is ambiguous by nature and
 * the recording is the thing being protected.
 */
export function createSilenceTracker({ warnAfter = 3 } = {}) {
  let consecutive = 0;

  return {
    /** @returns {{state: "ok"|"quiet"|"silent", consecutive: number, changed: boolean}} */
    observe(silent) {
      const previous = consecutive;
      consecutive = silent ? consecutive + 1 : 0;

      const state = consecutive === 0 ? "ok" : consecutive >= warnAfter ? "silent" : "quiet";
      const previousState =
        previous === 0 ? "ok" : previous >= warnAfter ? "silent" : "quiet";

      return { state, consecutive, changed: state !== previousState };
    },
    reset() {
      consecutive = 0;
    },
    get consecutive() {
      return consecutive;
    },
  };
}

/**
 * Liveness: is capture still delivering audio frames?
 *
 * Split out of the recorder and made pure because the first version of this
 * guard was wrong in a way nothing could catch. It alarmed on the track's own
 * `mute` event, which Chrome fires on healthy microphones during a sample-rate
 * switch or a Bluetooth profile change, and it never retracted, so one
 * transient stall left a red "microphone disconnected" banner up permanently
 * while the mic was plugged in and working. A guard that cannot be driven
 * through both transitions in a test is a guard nobody has seen work.
 *
 * Frames arriving is the only evidence that means what the red banner claims.
 * Note what this deliberately does NOT catch: a connected but muted microphone
 * still delivers frames, they are just full of zeroes. That is silence, handled
 * by createSilenceTracker at the amber tier, and conflating the two is what
 * makes an alarm untrustworthy.
 */
export function createLivenessMonitor({ timeoutMs = 3000 } = {}) {
  let lastFrameAt = null;
  let stalled = false;

  return {
    /** Proof of life. Resumes automatically: recovery needs no user action. */
    frame(now) {
      lastFrameAt = now;
      if (!stalled) return { state: "live", changed: false };
      stalled = false;
      return { state: "live", changed: true };
    },

    /**
     * The watchdog tick. Before the first frame there is nothing to judge, so
     * it reports live rather than alarming on a recorder that has only just
     * been started.
     */
    check(now) {
      if (lastFrameAt === null) return { state: "live", changed: false };
      const overdue = now - lastFrameAt > timeoutMs;
      const changed = overdue !== stalled;
      stalled = overdue;
      return { state: stalled ? "stalled" : "live", changed };
    },

    reset() {
      lastFrameAt = null;
      stalled = false;
    },

    get stalled() {
      return stalled;
    },
  };
}
