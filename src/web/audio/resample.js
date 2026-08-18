/**
 * Downsample mono Float32 audio to 16kHz using box averaging.
 * Averaging acts as a crude anti-aliasing filter; see the plan for why
 * interpolation is the wrong choice here.
 */
export function downsampleTo16k(input, inputRate, targetRate = 16000) {
  if (inputRate < targetRate) {
    throw new Error(
      `Refusing to upsample from ${inputRate}Hz to ${targetRate}Hz`,
    );
  }
  if (inputRate === targetRate) return Float32Array.from(input);

  const ratio = inputRate / targetRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/**
 * Streaming counterpart to downsampleTo16k.
 *
 * downsampleTo16k is correct for a single, complete buffer, but the recorder
 * calls it once per AudioWorkletNode message, and a render quantum is 128
 * frames -- not a multiple of the input/output ratio in general (e.g. 48000
 * -> 16000 is 3:1, and floor(128/3) leaves 2 input samples unconsumed every
 * single call). Calling the pure function fresh each time silently drops
 * that remainder forever. This factory carries the unconsumed tail of input
 * (as whole samples, via `pending`) plus the fractional read position within
 * the next output window (`phase`) across calls, so no input sample is ever
 * dropped at a buffer boundary, including for non-integer ratios like
 * 44100/16000 = 2.75625.
 */
export function createDownsampler(inputRate, targetRate = 16000) {
  if (inputRate < targetRate) {
    throw new Error(
      `Refusing to upsample from ${inputRate}Hz to ${targetRate}Hz`,
    );
  }

  const ratio = inputRate / targetRate;
  // Buffer of input samples not yet fully consumed into an output sample.
  let pending = new Float32Array(0);
  // Fractional start position of the next output window, measured in input
  // samples relative to the start of `pending`.
  let phase = 0;

  return {
    push(chunk) {
      if (ratio === 1) return Float32Array.from(chunk);

      // Combine leftover input with the new chunk.
      const combined = new Float32Array(pending.length + chunk.length);
      combined.set(pending, 0);
      combined.set(chunk, pending.length);

      const outputs = [];
      let start = phase;
      while (true) {
        const end = start + ratio;
        if (end > combined.length) break;

        const startIdx = Math.floor(start);
        const endIdx = Math.min(Math.ceil(end), combined.length);

        // Weighted average over [start, end), including fractional overlap
        // at the boundaries so no partial sample is thrown away.
        let sum = 0;
        let weight = 0;
        for (let j = startIdx; j < endIdx; j++) {
          const sampleStart = j;
          const sampleEnd = j + 1;
          const overlapStart = Math.max(sampleStart, start);
          const overlapEnd = Math.min(sampleEnd, end);
          const w = Math.max(0, overlapEnd - overlapStart);
          sum += combined[j] * w;
          weight += w;
        }
        outputs.push(weight > 0 ? sum / weight : 0);
        start = end;
      }

      // Whatever input remains after the last full output window becomes
      // the carry-over for next call. `start` is the position (in combined
      // sample units) where the next window would begin.
      const consumedWhole = Math.floor(start);
      phase = start - consumedWhole;
      pending = combined.slice(consumedWhole);

      return Float32Array.from(outputs);
    },
  };
}
