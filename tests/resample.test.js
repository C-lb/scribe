import { describe, it, expect } from "vitest";
import { downsampleTo16k } from "../src/web/audio/resample.js";

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
