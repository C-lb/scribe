import { describe, it, expect } from "vitest";
import { insertionIndex } from "../src/web/dnd.js";

// Three 40px rows starting at y=100, as a real sidebar would report them.
const rows = [
  { top: 100, bottom: 140 },
  { top: 140, bottom: 180 },
  { top: 180, bottom: 220 },
];

describe("insertionIndex", () => {
  it("returns 0 for an empty category", () => {
    expect(insertionIndex(150, [])).toBe(0);
  });

  it("drops above the first row into the first slot", () => {
    expect(insertionIndex(100, rows)).toBe(0);
    expect(insertionIndex(119, rows)).toBe(0);
  });

  it("drops below a row's midpoint into the slot after it", () => {
    expect(insertionIndex(121, rows)).toBe(1);
    expect(insertionIndex(161, rows)).toBe(2);
  });

  it("drops below the last row into the last slot", () => {
    expect(insertionIndex(219, rows)).toBe(3);
    expect(insertionIndex(9999, rows)).toBe(3);
  });

  it("puts a pointer exactly on a midpoint into the slot after that row", () => {
    expect(insertionIndex(120, rows)).toBe(1);
  });

  it("clamps a pointer above the list to the first slot", () => {
    expect(insertionIndex(-50, rows)).toBe(0);
  });
});
