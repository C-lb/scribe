import { describe, it, expect } from "vitest";
import { findCutPoint } from "../src/web/audio/chunker.js";

const RATE = 16000;

/** Build a buffer of `seconds` of loud noise with a quiet gap inserted. */
function withGapAt(seconds, gapAtSeconds, gapMs = 200) {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? 0.5 : -0.5;
  const start = Math.round(gapAtSeconds * RATE);
  const end = start + Math.round((gapMs / 1000) * RATE);
  for (let i = start; i < end && i < samples.length; i++) samples[i] = 0;
  return samples;
}

describe("findCutPoint", () => {
  it("returns null before the minimum chunk length is buffered", () => {
    const samples = withGapAt(10, 8);
    expect(findCutPoint(samples, RATE, { minSeconds: 15, maxSeconds: 25 })).toBeNull();
  });

  it("cuts at the quiet gap inside the search window", () => {
    const samples = withGapAt(25, 19);
    const cut = findCutPoint(samples, RATE, { minSeconds: 15, maxSeconds: 25 });
    expect(cut).not.toBeNull();
    // Cut should land within the 200ms gap that starts at 19s.
    expect(cut / RATE).toBeGreaterThanOrEqual(19);
    expect(cut / RATE).toBeLessThanOrEqual(19.3);
  });

  it("ignores a quiet gap that falls before the search window", () => {
    const samples = withGapAt(25, 5);
    const cut = findCutPoint(samples, RATE, { minSeconds: 15, maxSeconds: 25 });
    expect(cut / RATE).toBeGreaterThanOrEqual(15);
  });

  it("still returns a cut inside the window when the audio is uniformly loud", () => {
    const samples = new Float32Array(25 * RATE).fill(0.5);
    const cut = findCutPoint(samples, RATE, { minSeconds: 15, maxSeconds: 25 });
    expect(cut).not.toBeNull();
    expect(cut / RATE).toBeGreaterThanOrEqual(15);
    expect(cut / RATE).toBeLessThanOrEqual(25);
  });

  it("never returns a cut beyond the maximum, even with a long buffer", () => {
    const samples = withGapAt(60, 40);
    const cut = findCutPoint(samples, RATE, { minSeconds: 15, maxSeconds: 25 });
    expect(cut / RATE).toBeLessThanOrEqual(25);
  });
});
