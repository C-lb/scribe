import { createDownsampler } from "./resample.js";
import { encodeWav } from "./wav.js";
import { findCutPoint } from "./chunker.js";
import { rms, isSilent } from "./level.js";

const TARGET_RATE = 16000;

/** How often the live level is reported. Fast enough to look live, slow enough
 *  not to lay out the meter on every 128-frame render quantum. */
const LEVEL_INTERVAL_MS = 100;

/**
 * @param onChunk    called per chunk; the chunk carries `level` and `silent`
 *                   so the caller can decide not to upload it.
 * @param onLevel    called ~10x/second with the current input RMS, for a meter.
 * @param onDeviceLost   called when the capture track dies under us: unplugged,
 *                   muted at the OS, or taken by another application. The
 *                   recorder does NOT stop itself, because a lecture that keeps
 *                   running is recoverable and one that stopped is not.
 */
export function createRecorder({ chunkSeconds = 20, onChunk, onLevel, onDeviceLost }) {
  let context = null;
  let stream = null;
  let node = null;
  let buffer = new Float32Array(0);
  let index = 0;
  let emittedSamples = 0;
  let downsampler = null;
  let lastLevelAt = 0;
  let deviceLost = false;

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
    // Once, not once per event: a single unplug fires `mute` and `ended` on the
    // track and a `devicechange` on the device list, and three red banners for
    // one cable is noise.
    if (deviceLost) return;
    deviceLost = true;
    safely(onDeviceLost, { reason });
  }

  function watchTrack(track) {
    if (!track) return;
    track.addEventListener("ended", () => reportDeviceLost("ended"));
    track.addEventListener("mute", () => reportDeviceLost("muted"));
    track.addEventListener("unmute", () => {
      deviceLost = false;
    });
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

  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Both are tuned for close-mic phone calls. On a lecturer thirty feet
          // away they chew up exactly the quiet speech we need.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      context = new AudioContext();
      await context.audioWorklet.addModule("/audio/worklet.js");

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
    },

    async stop() {
      if (node) node.port.onmessage = null;
      if (stream) for (const track of stream.getTracks()) track.stop();
      if (context) await context.close();

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

      context = null;
      stream = null;
      node = null;
      downsampler = null;
      deviceLost = false;
      safely(onLevel, 0);
    },
  };
}
