import { describe, it, expect } from "vitest";
import {
  rms,
  isSilent,
  toDbfs,
  meterPosition,
  createSilenceTracker,
  createLivenessMonitor,
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

describe("createLivenessMonitor", () => {
  it("is live before the first frame, rather than alarming on a fresh recorder", () => {
    const monitor = createLivenessMonitor({ timeoutMs: 3000 });
    expect(monitor.check(999_999)).toEqual({ state: "live", changed: false });
    expect(monitor.stalled).toBe(false);
  });

  it("stays live while frames keep arriving", () => {
    const monitor = createLivenessMonitor({ timeoutMs: 3000 });
    monitor.frame(0);
    expect(monitor.check(1000).state).toBe("live");
    monitor.frame(1000);
    expect(monitor.check(2000).state).toBe("live");
  });

  it("goes stalled once, only after the timeout is exceeded", () => {
    const monitor = createLivenessMonitor({ timeoutMs: 3000 });
    monitor.frame(0);
    // On the boundary is not over it: scheduler jitter must not trip the alarm.
    expect(monitor.check(3000)).toEqual({ state: "live", changed: false });
    expect(monitor.check(3001)).toEqual({ state: "stalled", changed: true });
    // And it does not re-announce itself on every tick of the watchdog.
    expect(monitor.check(4000)).toEqual({ state: "stalled", changed: false });
  });

  it("retracts itself when a frame arrives, with no user action", () => {
    // The bug this whole monitor exists for: a transient stall used to leave a
    // red "microphone disconnected" banner up permanently on a working mic.
    const monitor = createLivenessMonitor({ timeoutMs: 3000 });
    monitor.frame(0);
    expect(monitor.check(5000).state).toBe("stalled");
    expect(monitor.frame(5100)).toEqual({ state: "live", changed: true });
    expect(monitor.stalled).toBe(false);
    // Retracted once, not once per frame.
    expect(monitor.frame(5200)).toEqual({ state: "live", changed: false });
  });

  it("recovers through the watchdog too, not only through a frame", () => {
    const monitor = createLivenessMonitor({ timeoutMs: 3000 });
    monitor.frame(0);
    expect(monitor.check(9000).state).toBe("stalled");
    monitor.frame(9000);
    expect(monitor.check(9500)).toEqual({ state: "live", changed: false });
  });

  it("survives a stall, a recovery and a second stall", () => {
    const monitor = createLivenessMonitor({ timeoutMs: 1000 });
    monitor.frame(0);
    expect(monitor.check(2000).changed).toBe(true);
    monitor.frame(2100);
    expect(monitor.check(2200).state).toBe("live");
    expect(monitor.check(4000)).toEqual({ state: "stalled", changed: true });
  });

  it("resets to the pre-first-frame state", () => {
    const monitor = createLivenessMonitor({ timeoutMs: 1000 });
    monitor.frame(0);
    monitor.check(5000);
    expect(monitor.stalled).toBe(true);
    monitor.reset();
    expect(monitor.stalled).toBe(false);
    expect(monitor.check(999_999)).toEqual({ state: "live", changed: false });
  });
});
