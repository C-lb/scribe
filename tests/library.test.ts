import { describe, it, expect } from "vitest";
import { isSessionId, defaultTitle, emptyLibrary } from "../src/server/library.js";

describe("session ids", () => {
  it("accepts the id shape Session.create produces", () => {
    expect(isSessionId("2026-08-18-17-03-30")).toBe(true);
  });

  it("rejects traversal and anything outside the shape", () => {
    for (const bad of ["..", "../etc", "2026-08-18", "a/b", "2026-08-18-17-03-30/x", ""]) {
      expect(isSessionId(bad)).toBe(false);
    }
  });
});

describe("defaultTitle", () => {
  it("reads the date and time out of the id", () => {
    expect(defaultTitle("2026-08-18-17-03-30")).toBe("18 August 2026, 17:03");
  });

  it("returns the id unchanged when it is not a session id", () => {
    expect(defaultTitle("nonsense")).toBe("nonsense");
  });
});

describe("emptyLibrary", () => {
  it("is a valid version 1 file with nothing in it", () => {
    expect(emptyLibrary()).toEqual({ version: 1, categories: [], entries: {} });
  });
});
