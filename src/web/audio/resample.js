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
