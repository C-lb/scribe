import { describe, it, expect } from "vitest";
import {
  rms,
  isSilent,
  toDbfs,
  meterPosition,
  createSilenceTracker,
  SILENCE_RMS,
} from "../src/web/audio/level.js";

function tone(length, amplitude) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin((i / 16) * Math.PI * 2) * amplitude;
  return out;
}

describe("rms", () => {
  it("is zero for an empty frame rather than NaN", () => {
    // NaN would compare false against every threshold and silently disable
    // the gate, which is the one failure mode that loses lecture audio.
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(null)).toBe(0);
  });

  it("is zero for digital silence", () => {
    expect(rms(new Float32Array(1000))).toBe(0);
  });

  it("is the amplitude for a constant frame", () => {
    const frame = new Float32Array(100).fill(0.5);
    expect(rms(frame)).toBeCloseTo(0.5, 6);
  });

  it("is amplitude over root two for a sine", () => {
    expect(rms(tone(1600, 1))).toBeCloseTo(1 / Math.SQRT2, 2);
  });
});

describe("isSilent", () => {
  it("gates digital silence", () => {
    expect(isSilent(new Float32Array(1000))).toBe(true);
  });

  it("gates a frame below the threshold", () => {
    expect(isSilent(new Float32Array(1000).fill(SILENCE_RMS / 2))).toBe(true);
  });

  it("passes quiet, distant speech", () => {
    // The whole point of a near-zero gate: a lecturer thirty feet from the mic
    // with autoGainControl off is quiet, and must never be dropped.
    expect(isSilent(tone(1600, 0.01))).toBe(false);
  });

  it("passes ordinary speech", () => {
    expect(isSilent(tone(1600, 0.2))).toBe(false);
  });
});

describe("toDbfs", () => {
  it("floors at -100 for digital zero instead of returning -Infinity", () => {
    expect(toDbfs(0)).toBe(-100);
    expect(toDbfs(-1)).toBe(-100);
  });

  it("puts full scale at 0 dB", () => {
    expect(toDbfs(1)).toBeCloseTo(0, 6);
  });

  it("puts half amplitude near -6 dB", () => {
    expect(toDbfs(0.5)).toBeCloseTo(-6.02, 1);
  });
});

describe("meterPosition", () => {
  it("clamps to 0 at and below the floor", () => {
    expect(meterPosition(0)).toBe(0);
    expect(meterPosition(0.0001)).toBe(0);
  });

  it("clamps to 1 at and above the ceiling", () => {
    expect(meterPosition(1)).toBe(1);
  });

  it("puts ordinary speech in the visible middle of the bar", () => {
    // A linear amplitude mapping would put this near 0.05 and read as broken.
    const position = meterPosition(0.05);
    expect(position).toBeGreaterThan(0.25);
    expect(position).toBeLessThan(0.85);
  });

  it("rises monotonically with level", () => {
    expect(meterPosition(0.02)).toBeLessThan(meterPosition(0.2));
  });
});

describe("createSilenceTracker", () => {
  it("reports ok while speech arrives", () => {
    const tracker = createSilenceTracker({ warnAfter: 3 });
    expect(tracker.observe(false)).toEqual({ state: "ok", consecutive: 0, changed: false });
  });

  it("reports quiet for a single silent chunk", () => {
    const tracker = createSilenceTracker({ warnAfter: 3 });
    const result = tracker.observe(true);
    expect(result.state).toBe("quiet");
    expect(result.changed).toBe(true);
  });

  it("escalates to silent only on the warnAfter-th consecutive chunk", () => {
    const tracker = createSilenceTracker({ warnAfter: 3 });
    expect(tracker.observe(true).state).toBe("quiet");
    expect(tracker.observe(true).state).toBe("quiet");
    expect(tracker.observe(true).state).toBe("silent");
  });

  it("stays silent without re-reporting a change once escalated", () => {
    const tracker = createSilenceTracker({ warnAfter: 2 });
    tracker.observe(true);
    expect(tracker.observe(true).changed).toBe(true);
    expect(tracker.observe(true)).toEqual({ state: "silent", consecutive: 3, changed: false });
  });

  it("clears the run on any speech, so a pause never accumulates across a lecture", () => {
    const tracker = createSilenceTracker({ warnAfter: 3 });
    tracker.observe(true);
    tracker.observe(true);
    expect(tracker.observe(false).state).toBe("ok");
    expect(tracker.consecutive).toBe(0);
    // And the next silent chunk starts a fresh run rather than tipping over.
    expect(tracker.observe(true).state).toBe("quiet");
  });

  it("resets", () => {
    const tracker = createSilenceTracker({ warnAfter: 2 });
    tracker.observe(true);
    tracker.observe(true);
    tracker.reset();
    expect(tracker.consecutive).toBe(0);
    expect(tracker.observe(true).state).toBe("quiet");
  });
});
