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
  it("defaults SCRIBE_STT to auto with the Voicebox desktop port", () => {
    const c = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(c.sttEngine).toBe("auto");
    expect(c.voiceboxUrl).toBe("http://127.0.0.1:17493");
    expect(c.voiceboxModel).toBeNull();
  });

  it("lets GROQ_API_KEY be absent only when SCRIBE_STT=voicebox", () => {
    const c = loadConfig({
      ANTHROPIC_API_KEY: "sk-ant-test",
      SCRIBE_STT: "voicebox",
    } as NodeJS.ProcessEnv);
    expect(c.groqApiKey).toBeNull();
    expect(() =>
      loadConfig({ ANTHROPIC_API_KEY: "sk-ant-test", SCRIBE_STT: "auto" } as NodeJS.ProcessEnv),
    ).toThrow(/GROQ_API_KEY/);
  });

  it("strips a trailing slash from SCRIBE_VOICEBOX_URL and rejects unknown engines", () => {
    const c = loadConfig({ ...base, SCRIBE_VOICEBOX_URL: "http://localhost:9999/" } as NodeJS.ProcessEnv);
    expect(c.voiceboxUrl).toBe("http://localhost:9999");
    expect(() => loadConfig({ ...base, SCRIBE_STT: "whisper" } as NodeJS.ProcessEnv)).toThrow(/SCRIBE_STT/);
  });
});
