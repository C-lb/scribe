import { describe, it, expect } from "vitest";
import { downsampleTo16k, createDownsampler } from "../src/web/audio/resample.js";

describe("downsampleTo16k", () => {
  it("returns a copy unchanged when already at the target rate", () => {
    const input = Float32Array.from([0.1, -0.2, 0.3]);
    const out = downsampleTo16k(input, 16000);
    expect(Array.from(out)).toEqual([0.1, -0.2, 0.3].map((n) => Math.fround(n)));
    expect(out).not.toBe(input);
  });

  it("reduces 48kHz to a third of the sample count", () => {
    const input = new Float32Array(48000);
    const out = downsampleTo16k(input, 48000);
    expect(out.length).toBe(16000);
  });

  it("averages each group of source samples rather than picking one", () => {
    // 3:1 ratio. First output sample must be the mean of the first three.
    const input = Float32Array.from([0, 0.3, 0.6, 1, 1, 1]);
    const out = downsampleTo16k(input, 48000);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.3, 5);
    expect(out[1]).toBeCloseTo(1.0, 5);
  });

  it("refuses to upsample", () => {
    expect(() => downsampleTo16k(new Float32Array(10), 8000)).toThrow(/upsample/i);
  });
});

// The recorder calls downsampleTo16k fresh on every AudioWorkletNode message,
// and a Web Audio render quantum is exactly 128 frames. At 48kHz the ratio is
// 3, so each 128-sample buffer produces floor(128/3) = 42 output samples,
// consuming only input samples 0..125 and silently discarding samples 126
// and 127 -- every single callback, for the whole recording. That is ~1.5625%
// of all audio gone, not merely mistimed: about 56 seconds per hour.
describe("createDownsampler (streaming, matches the real per-worklet-message call pattern)", () => {
  it("drops no samples across many consecutive 128-sample buffers at 48kHz", () => {
    const inputRate = 48000;
    const ratio = inputRate / 16000; // 3
    const quantum = 128;
    const numCallbacks = 1000; // ~2.67s of audio, plenty of quantum boundaries
    const totalInputSamples = quantum * numCallbacks;

    const downsampler = createDownsampler(inputRate, 16000);
    let totalOut = 0;
    for (let i = 0; i < numCallbacks; i++) {
      const chunk = new Float32Array(quantum).fill(1);
      totalOut += downsampler.push(chunk).length;
    }

    const expected = totalInputSamples / ratio; // exact: 128*1000/3 is not integral, use floor/ceil tolerance
    expect(Math.abs(totalOut - expected)).toBeLessThanOrEqual(1);
  });

  it("drops no samples across many consecutive 128-sample buffers at 44100Hz (non-integer ratio)", () => {
    const inputRate = 44100;
    const ratio = inputRate / 16000; // 2.75625
    const quantum = 128;
    const numCallbacks = 1000;
    const totalInputSamples = quantum * numCallbacks;

    const downsampler = createDownsampler(inputRate, 16000);
    let totalOut = 0;
    for (let i = 0; i < numCallbacks; i++) {
      const chunk = new Float32Array(quantum).fill(1);
      totalOut += downsampler.push(chunk).length;
    }

    const expected = totalInputSamples / ratio;
    expect(Math.abs(totalOut - expected)).toBeLessThanOrEqual(1);
  });

  it("accounts for the full input duration using a counting ramp, not just a sample count", () => {
    // Push a monotonically increasing ramp across many small buffers, and
    // verify the output is a smooth, monotonically non-decreasing downsampled
    // version that reaches (nearly) the same final value as the input -- if
    // a chunk boundary silently dropped samples, the output would either be
    // short or jump/plateau unexpectedly less than the true progression.
    const inputRate = 48000;
    const quantum = 128;
    const numCallbacks = 500;
    const downsampler = createDownsampler(inputRate, 16000);

    let sampleCounter = 0;
    let out = [];
    for (let i = 0; i < numCallbacks; i++) {
      const chunk = new Float32Array(quantum);
      for (let j = 0; j < quantum; j++) chunk[j] = sampleCounter++;
      out.push(...downsampler.push(chunk));
    }

    const totalInputSamples = quantum * numCallbacks;
    const ratio = inputRate / 16000;
    const expectedLen = totalInputSamples / ratio;
    expect(Math.abs(out.length - expectedLen)).toBeLessThanOrEqual(1);

    // Monotonically non-decreasing (box averaging of an increasing ramp).
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1] - 1e-6);
    }

    // The last output sample must be close to the true final average, i.e.
    // near the end of the input range -- not truncated early by dropped tail
    // samples at each buffer boundary.
    const lastExpectedApprox = totalInputSamples - ratio; // roughly where the last window starts
    expect(out[out.length - 1]).toBeGreaterThan(lastExpectedApprox - ratio * 2);
  });

  it("matches the one-shot downsampleTo16k when fed as a single push", () => {
    const input = Float32Array.from([0, 0.3, 0.6, 1, 1, 1]);
    const oneShot = downsampleTo16k(input, 48000);
    const streaming = createDownsampler(48000).push(input);
    expect(Array.from(streaming)).toEqual(Array.from(oneShot));
  });
});
