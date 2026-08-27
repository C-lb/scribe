import { describe, it, expect } from "vitest";
import { joinWavs } from "../src/server/wav-join.js";

/** A 44-byte header plus `samples` 16-bit samples of a constant value. */
function wav(samples: number, value = 1): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(value, i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("joinWavs", () => {
  it("produces one header and every sample", () => {
    const joined = joinWavs([wav(10, 1), wav(5, 2)]);
    expect(joined.length).toBe(44 + 15 * 2);
    expect(joined.toString("ascii", 0, 4)).toBe("RIFF");
    expect(joined.readUInt32LE(4)).toBe(36 + 15 * 2);
    expect(joined.readUInt32LE(40)).toBe(15 * 2);
    expect(joined.readUInt32LE(24)).toBe(16000);
    expect(joined.readInt16LE(44)).toBe(1);
    expect(joined.readInt16LE(44 + 10 * 2)).toBe(2);
  });

  it("returns a valid empty WAV for no input", () => {
    expect(joinWavs([]).length).toBe(44);
  });

  it("rejects a buffer shorter than a WAV header", () => {
    expect(() => joinWavs([Buffer.alloc(10)])).toThrow();
  });
});
