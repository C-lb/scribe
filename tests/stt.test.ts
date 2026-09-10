import { describe, it, expect, vi } from "vitest";
import { createTranscriber } from "../src/server/stt.js";
import { LocalSttUnavailable } from "../src/server/local-stt.js";

const audio = Buffer.alloc(8);

function fakes(opts: { localUp: boolean; groq?: boolean }) {
  const local = {
    transcribe: vi.fn(async () => {
      if (!opts.localUp) throw new LocalSttUnavailable("not running");
      return "from local";
    }),
  };
  const groq = opts.groq === false ? null : { transcribe: vi.fn(async () => "from groq") };
  const log = vi.fn();
  return { local, groq, log };
}

describe("createTranscriber", () => {
  it("auto: uses local Whisper when it answers and never touches Groq", async () => {
    const d = fakes({ localUp: true });
    const t = createTranscriber({ sttEngine: "auto" }, d);
    expect(await t.transcribe({ audio })).toBe("from local");
    expect(d.groq!.transcribe).not.toHaveBeenCalled();
    expect(t.lastEngine()).toBe("local");
  });

  it("auto: falls back to Groq per chunk when local Whisper is unavailable, logging once", async () => {
    const d = fakes({ localUp: false });
    const t = createTranscriber({ sttEngine: "auto" }, d);
    expect(await t.transcribe({ audio })).toBe("from groq");
    expect(await t.transcribe({ audio })).toBe("from groq");
    expect(d.local.transcribe).toHaveBeenCalledTimes(2);
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.log.mock.calls[0][0]).toMatch(/unavailable.*Groq/);
    expect(t.lastEngine()).toBe("groq");
  });

  it("auto: a local error that is not 'unavailable' propagates instead of going to the cloud", async () => {
    const d = fakes({ localUp: true });
    d.local.transcribe.mockRejectedValueOnce(new Error("local Whisper responded 500"));
    const t = createTranscriber({ sttEngine: "auto" }, d);
    await expect(t.transcribe({ audio })).rejects.toThrow(/500/);
    expect(d.groq!.transcribe).not.toHaveBeenCalled();
  });

  it("auto: with no Groq key the fallback is a named error, not a silent empty line", async () => {
    const d = fakes({ localUp: false, groq: false });
    const t = createTranscriber({ sttEngine: "auto" }, d);
    await expect(t.transcribe({ audio })).rejects.toThrow(/GROQ_API_KEY/);
  });

  it("local: never falls back, even when unavailable", async () => {
    const d = fakes({ localUp: false });
    const t = createTranscriber({ sttEngine: "local" }, d);
    await expect(t.transcribe({ audio })).rejects.toBeInstanceOf(LocalSttUnavailable);
    expect(d.groq!.transcribe).not.toHaveBeenCalled();
  });

  it("groq: never tries local", async () => {
    const d = fakes({ localUp: true });
    const t = createTranscriber({ sttEngine: "groq" }, d);
    expect(await t.transcribe({ audio })).toBe("from groq");
    expect(d.local.transcribe).not.toHaveBeenCalled();
  });
});
