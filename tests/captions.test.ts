import { describe, it, expect } from "vitest";
import { toSrt, toVtt, toPlainText } from "../src/server/captions.js";

const lines = [
  { index: 0, startMs: 0, endMs: 20_000, text: "First line", failed: false },
  { index: 2, startMs: 40_000, endMs: 63_500, text: "Third line", failed: false },
];

describe("toSrt", () => {
  it("numbers cues from one and uses comma milliseconds", () => {
    expect(toSrt(lines)).toBe(
      "1\n00:00:00,000 --> 00:00:20,000\nFirst line\n\n" +
      "2\n00:00:40,000 --> 00:01:03,500\nThird line\n",
    );
  });

  it("renumbers rather than reusing chunk indexes, because a dropped chunk leaves a hole", () => {
    expect(toSrt(lines).startsWith("1\n")).toBe(true);
    expect(toSrt(lines)).toContain("\n2\n");
  });
});

describe("toVtt", () => {
  it("opens with the WEBVTT header and uses dot milliseconds", () => {
    expect(toVtt(lines).startsWith("WEBVTT\n\n")).toBe(true);
    expect(toVtt(lines)).toContain("00:00:00.000 --> 00:00:20.000");
  });
});

describe("toPlainText", () => {
  it("drops the timestamps and joins into paragraphs", () => {
    expect(toPlainText(lines)).toBe("First line\n\nThird line\n");
  });

  it("leaves out a failed line rather than writing [inaudible] into a caption file", () => {
    const withFailure = [...lines, { index: 3, startMs: 63_500, endMs: 80_000, text: "[inaudible ~01:03]", failed: true }];
    expect(toPlainText(withFailure)).not.toContain("inaudible");
  });
});
