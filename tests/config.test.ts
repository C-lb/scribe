import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/server/config.js";

const base = {
  GROQ_API_KEY: "gsk_test",
  ANTHROPIC_API_KEY: "sk-ant-test",
};

describe("loadConfig", () => {
  it("applies documented defaults when only keys are set", () => {
    const c = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(c.chunkSeconds).toBe(20);
    expect(c.summaryIntervalMinutes).toBe(5);
    expect(c.runningModel).toBe("claude-opus-5");
    expect(c.finalModel).toBe("claude-opus-5");
    expect(c.keepAudio).toBe(true);
    expect(c.port).toBe(4747);
    expect(c.language).toBe("en");
  });

  it("throws a named error when GROQ_API_KEY is missing", () => {
    expect(() =>
      loadConfig({ ANTHROPIC_API_KEY: "sk-ant-test" } as NodeJS.ProcessEnv),
    ).toThrow(/GROQ_API_KEY/);
  });

  it("throws a named error when ANTHROPIC_API_KEY is missing", () => {
    expect(() =>
      loadConfig({ GROQ_API_KEY: "gsk_test" } as NodeJS.ProcessEnv),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("reads SCRIBE_KEEP_AUDIO=false as a boolean false", () => {
    const c = loadConfig({
      ...base,
      SCRIBE_KEEP_AUDIO: "false",
    } as NodeJS.ProcessEnv);
    expect(c.keepAudio).toBe(false);
  });

  it("rejects a non-numeric chunk length rather than silently defaulting", () => {
    expect(() =>
      loadConfig({ ...base, SCRIBE_CHUNK_SECONDS: "abc" } as NodeJS.ProcessEnv),
    ).toThrow(/SCRIBE_CHUNK_SECONDS/);
  });
});
