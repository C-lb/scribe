import { createDownsampler } from "./resample.js";
import { encodeWav } from "./wav.js";
import { findCutPoint } from "./chunker.js";
import { rms, isSilent, createLivenessMonitor } from "./level.js";

const TARGET_RATE = 16000;

/** How often the live level is reported. Fast enough to look live, slow enough
 *  not to lay out the meter on every 128-frame render quantum. */
const LEVEL_INTERVAL_MS = 100;

/**
 * How long without a single audio frame before the capture counts as dead.
 *
 * Frames arrive every few milliseconds while a track is alive, so this is
 * enormous in comparison and will not trip on scheduler jitter or a tab that
 * was briefly backgrounded. It is the one signal that actually means what the
 * red banner claims, which is why the banner is driven by this and not by the
 * track's own events.
 */
const FRAME_TIMEOUT_MS = 3000;

/** How often the watchdog checks. */
const WATCHDOG_INTERVAL_MS = 500;

/**
 * @param onChunk    called per chunk; the chunk carries `level` and `silent`
 *                   so the caller can decide not to upload it.
 * @param onLevel    called ~10x/second with the current input RMS, for a meter.
 * @param onDeviceLost   called when audio frames genuinely stop arriving. The
 *                   recorder does NOT stop itself, because a lecture that keeps
 *                   running is recoverable and one that stopped is not.
 * @param onDeviceBack  called when frames resume, so a transient stall retracts
 *                   its own alarm instead of leaving a stale one on screen.
 * @param onContextState  called with the AudioContext state whenever it
 *                   changes. macOS suspends it when another app takes the mic.
 * @param getDeviceId  returns the input device to open, or null for whatever
 *                   the browser picks. Read at open time, not captured once, so
 *                   a recovery picks up a device chosen since the recording
 *                   started.
 */
export function createRecorder({
  chunkSeconds = 20,
  onChunk,
  onLevel,
  onDeviceLost,
  onDeviceBack,
  onContextState,
  getDeviceId,
  onDeviceFallback,
  frameTimeoutMs = FRAME_TIMEOUT_MS,
}) {
  let context = null;
  let stream = null;
  let node = null;
  let buffer = new Float32Array(0);
  let index = 0;
  let emittedSamples = 0;
  let downsampler = null;
  let lastLevelAt = 0;
  let deviceLost = false;
  let watchdog = null;
  let stopping = false;
  const liveness = createLivenessMonitor({ timeoutMs: frameTimeoutMs });

  /** Guards every callback out of this module. A handler that throws must not
   *  be able to take down the capture loop, same rule as the worklet handler. */
  function safely(callback, ...args) {
    if (!callback) return;
    try {
      callback(...args);
    } catch (error) {
      console.error("[scribe] recorder callback failed", error);
    }
  }

  function reportLevel(samples) {
    if (!onLevel) return;
    const now = Date.now();
    if (now - lastLevelAt < LEVEL_INTERVAL_MS) return;
    lastLevelAt = now;
    safely(onLevel, rms(samples));
  }

  function reportDeviceLost(reason) {
    // Once per outage, not once per event. One unplug fires `mute` and `ended`
    // on the track and a `devicechange` on the device list; three red banners
    // for one cable is noise.
    if (deviceLost || stopping) return;
    deviceLost = true;
    safely(onDeviceLost, { reason });
  }

  /** Frames are flowing again. Retracts the alarm rather than waiting for the
   *  user to dismiss a banner that has stopped being true. */
  function reportDeviceBack() {
    if (!deviceLost) return;
    deviceLost = false;
    safely(onDeviceBack);
  }

  /**
   * The only authority on whether capture is alive.
   *
   * The track's own events are hints, not proof. Chrome fires `mute` on a
   * perfectly healthy microphone whenever the source stalls for a moment: a
   * sample-rate switch, a Bluetooth profile change, another application opening
   * the device. Alarming on that reported a disconnected mic to people whose
   * mic was plugged in and working, which is worse than saying nothing, because
   * an alarm that lies gets ignored when it is finally right.
   *
   * Frames arriving is the thing the red banner actually claims, so measure
   * that. Note this stays properly distinct from the silence tier: a muted but
   * connected mic still delivers frames, they are just full of zeroes, and that
   * is the amber case, not this one.
   */
  function checkFrames() {
    if (stopping) return;
    const { state, changed } = liveness.check(Date.now());
    if (!changed) return;
    if (state === "stalled") reportDeviceLost("stalled");
    else reportDeviceBack();
  }

  function watchTrack(track) {
    if (!track) return;
    // `ended` is terminal by definition and never fires for a stop() we called
    // ourselves, so it is trusted immediately.
    track.addEventListener("ended", () => reportDeviceLost("ended"));
    // `mute` only prompts an early look at the frame clock. If frames really
    // have stopped the watchdog would have caught it within the timeout anyway;
    // if they have not, nothing is shown at all.
    track.addEventListener("mute", () => checkFrames());
    track.addEventListener("unmute", () => checkFrames());
  }

  const minSeconds = Math.max(1, chunkSeconds - 5);
  const maxSeconds = chunkSeconds + 5;

  function append(samples) {
    const merged = new Float32Array(buffer.length + samples.length);
    merged.set(buffer, 0);
    merged.set(samples, buffer.length);
    buffer = merged;
  }

  function drainChunks() {
    for (;;) {
      const cut = findCutPoint(buffer, TARGET_RATE, { minSeconds, maxSeconds });
      if (cut === null) return;

      const slice = buffer.slice(0, cut);
      buffer = buffer.slice(cut);

      index += 1;
      const startMs = (emittedSamples / TARGET_RATE) * 1000;
      emittedSamples += slice.length;
      const endMs = (emittedSamples / TARGET_RATE) * 1000;

      const level = rms(slice);
      onChunk({
        index,
        startMs,
        endMs,
        wav: encodeWav(slice, TARGET_RATE),
        level,
        silent: isSilent(slice),
      });
    }
  }

  /**
   * Build the capture graph: device, context, worklet, wiring.
   *
   * Separate from start() so recover() can rebuild it without touching the
   * chunk buffer, the chunk index, or the elapsed sample count. A recovery that
   * reset those would renumber chunks mid-lecture and make the timestamps lie.
   */
  async function openGraph() {
    // Chrome keeps a per-SITE microphone preference that overrides the macOS
    // default, and it survives the device going away. An unqualified request
    // therefore hands back a device that is live, unmuted, enabled, and
    // delivering digital zero, with nothing in the track to say so. Naming the
    // device explicitly is the only way past that, which is why the UI has a
    // picker and why this is read fresh on every open.
    const deviceId = getDeviceId ? getDeviceId() : null;

    // Tuned for a lecturer thirty feet away: all three of these are built for
    // close-mic phone calls and chew up exactly the quiet speech we need.
    const base = {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };

    // `exact`, and it has to be. Measured on this machine: with `ideal`, Chrome
    // returned its per-site preferred device ("dabian Microphone", delivering
    // digital zero) even when the built-in mic was named explicitly. An `ideal`
    // deviceId is a suggestion the site preference outranks, so the picker
    // would have looked like it worked and changed nothing.
    if (deviceId) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { ...base, deviceId: { exact: deviceId } },
        });
      } catch (error) {
        // The remembered device is gone: unplugged, or a Continuity mic that
        // wandered off. Recording something beats recording nothing, so fall
        // through to whatever the browser will give us.
        console.warn(`[scribe] could not open the chosen microphone, falling back`, error);
        safely(onDeviceFallback, { error });
        stream = await navigator.mediaDevices.getUserMedia({ audio: base });
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    }

    context = new AudioContext();
    await context.audioWorklet.addModule("/audio/worklet.js");

    // macOS interrupts the audio session when another application opens the
    // input device: opening Camera, joining a call, anything that claims the
    // mic. The AudioContext is suspended and STAYS suspended, which stops the
    // worklet being pulled, which stops frames, which stops the recording,
    // while the microphone itself remains perfectly connected. Nothing resumes
    // it on its own, so this does.
    context.addEventListener("statechange", () => {
      if (stopping || !context) return;
      safely(onContextState, context.state);
      if (context.state === "running") return;
      console.warn(`[scribe] audio context went ${context.state}, resuming`);
      context.resume().catch((error) => {
        // Browsers can refuse a resume that is not tied to a user gesture,
        // which is exactly why the UI carries its own reconnect control.
        console.error("[scribe] could not resume the audio context", error);
        reportDeviceLost("suspended");
      });
    });

    for (const track of stream.getAudioTracks()) watchTrack(track);

    const source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "tap");
    downsampler = createDownsampler(context.sampleRate, TARGET_RATE);
    // A render quantum (128 frames) is not a multiple of the
    // input/output ratio in general, so downsampling must carry its
    // remainder across calls -- see createDownsampler. This handler also
    // sits next to the capture path: a malformed worklet message must
    // never be able to throw and take the recording down mid-lecture.
    node.port.onmessage = (event) => {
      try {
        // Proof of life, stamped before anything that could throw.
        if (liveness.frame(Date.now()).changed) reportDeviceBack();

        // Metered before the downsampler so a broken resample cannot make the
        // meter read silent, which would send the user hunting the wrong fault.
        reportLevel(event.data);
        append(downsampler.push(event.data));
        drainChunks();
      } catch (error) {
        console.error("[scribe] failed to handle worklet message", error);
      }
    };

    source.connect(node);
    // Keep the graph pulling without routing the mic to the speakers.
    const sink = context.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(context.destination);
  }

  /** Tear the graph down without flushing. Recovery keeps the buffer. */
  async function closeGraph() {
    if (node) node.port.onmessage = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    if (context) await context.close().catch(() => {});
    context = null;
    stream = null;
    node = null;
    downsampler = null;
  }

  return {
    async start() {
      stopping = false;
      deviceLost = false;
      liveness.reset();
      await openGraph();
      watchdog = setInterval(checkFrames, WATCHDOG_INTERVAL_MS);
    },

    /**
     * Put capture back, cheapest repair first.
     *
     * Resuming a suspended context is the common case and keeps the same
     * device, so it is tried first. Only if that does not restore frames is the
     * whole graph rebuilt, which re-runs getUserMedia and picks up whatever the
     * current default input now is. Both paths preserve the buffer and the
     * chunk numbering, so a recovery is invisible in the transcript.
     */
    async recover() {
      if (stopping) return { ok: false, how: "stopped" };

      if (context && context.state !== "running") {
        try {
          await context.resume();
          if (context.state === "running") {
            liveness.reset();
            return { ok: true, how: "resumed" };
          }
        } catch (error) {
          console.warn("[scribe] resume failed, rebuilding the graph", error);
        }
      }

      await closeGraph();
      await openGraph();
      liveness.reset();
      deviceLost = false;
      return { ok: true, how: "reopened" };
    },

    /** The device actually opened. `ideal` can silently give you another one,
     *  so the UI reports what was granted rather than what was requested. */
    get deviceLabel() {
      const track = stream && stream.getAudioTracks()[0];
      return track ? track.label : null;
    },

    /** What the context is doing, for the UI to report honestly. */
    get contextState() {
      return context ? context.state : "closed";
    },

    async stop() {
      // Set before anything is torn down: tearing a graph down stops frames by
      // definition, and the watchdog must not report our own stop as a fault.
      stopping = true;
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      await closeGraph();

      // Flush whatever is left, however short.
      if (buffer.length > 0) {
        index += 1;
        const startMs = (emittedSamples / TARGET_RATE) * 1000;
        emittedSamples += buffer.length;
        const endMs = (emittedSamples / TARGET_RATE) * 1000;
        onChunk({
          index,
          startMs,
          endMs,
          wav: encodeWav(buffer, TARGET_RATE),
          level: rms(buffer),
          silent: isSilent(buffer),
        });
        buffer = new Float32Array(0);
      }

      deviceLost = false;
      liveness.reset();
      safely(onLevel, 0);
    },
  };
}
