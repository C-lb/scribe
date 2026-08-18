/**
 * Choose where to cut a rolling audio buffer into a chunk.
 *
 * Cutting on a fixed timer slices mid-word roughly every chunk, and Whisper
 * transcribes a half-word as either nothing or the wrong word. Instead we scan
 * a window of allowed cut positions for the quietest short frame — the gap
 * between two words — and cut there.
 *
 * Returns the sample index to cut at, or null if minSeconds is not yet buffered.
 */
export function findCutPoint(samples, sampleRate, opts = {}) {
  const { minSeconds = 15, maxSeconds = 25, frameMs = 100 } = opts;

  const minSample = Math.round(minSeconds * sampleRate);
  if (samples.length < minSample) return null;

  const maxSample = Math.min(Math.round(maxSeconds * sampleRate), samples.length);
  const frame = Math.max(1, Math.round((frameMs / 1000) * sampleRate));

  let bestEnergy = Infinity;
  let bestCut = maxSample;

  for (let start = minSample; start + frame <= maxSample; start += frame) {
    let sum = 0;
    for (let i = start; i < start + frame; i++) sum += samples[i] * samples[i];
    const energy = sum / frame;
    if (energy < bestEnergy) {
      bestEnergy = energy;
      // Cut at the end of the quiet frame so the pause belongs to this chunk
      // rather than opening the next one.
      bestCut = start + frame;
    }
  }
  return bestCut;
}
