import { describe, it, expect } from "vitest";
import { encodeWav } from "../src/web/audio/wav.js";

function ascii(view, offset, length) {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe("encodeWav", () => {
  it("writes a 44-byte header followed by 16-bit samples", () => {
    const samples = Float32Array.from([0, 0.5, -0.5]);
    const buffer = encodeWav(samples, 16000);
    expect(buffer.byteLength).toBe(44 + 3 * 2);
  });

  it("writes the RIFF/WAVE/fmt/data chunk identifiers", () => {
    const view = new DataView(encodeWav(Float32Array.from([0]), 16000));
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(ascii(view, 36, 4)).toBe("data");
  });

  it("declares mono 16-bit PCM at the given sample rate", () => {
    const view = new DataView(encodeWav(new Float32Array(10), 16000));
    expect(view.getUint32(16, true)).toBe(16);   // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1);    // PCM
    expect(view.getUint16(22, true)).toBe(1);    // channels
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(28, true)).toBe(32000); // byte rate = 16000 * 1 * 2
    expect(view.getUint16(32, true)).toBe(2);    // block align
    expect(view.getUint16(34, true)).toBe(16);   // bits per sample
  });

  it("converts full-scale samples without wrapping around", () => {
    const view = new DataView(encodeWav(Float32Array.from([1, -1]), 16000));
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it("clamps samples beyond full scale instead of wrapping", () => {
    const view = new DataView(encodeWav(Float32Array.from([1.8, -1.8]), 16000));
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });
});
