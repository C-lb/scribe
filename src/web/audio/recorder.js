import { downsampleTo16k } from "./resample.js";
import { encodeWav } from "./wav.js";
import { findCutPoint } from "./chunker.js";

const TARGET_RATE = 16000;

export function createRecorder({ chunkSeconds = 20, onChunk }) {
  let context = null;
  let stream = null;
  let node = null;
  let buffer = new Float32Array(0);
  let index = 0;
  let emittedSamples = 0;

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

      onChunk({ index, startMs, endMs, wav: encodeWav(slice, TARGET_RATE) });
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

      const source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, "tap");
      node.port.onmessage = (event) => {
        append(downsampleTo16k(event.data, context.sampleRate, TARGET_RATE));
        drainChunks();
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
        onChunk({ index, startMs, endMs, wav: encodeWav(buffer, TARGET_RATE) });
        buffer = new Float32Array(0);
      }

      context = null;
      stream = null;
      node = null;
    },
  };
}
