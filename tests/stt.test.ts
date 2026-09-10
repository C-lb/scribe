import { describe, it, expect, vi } from "vitest";
import { createTranscriber } from "../src/server/stt.js";
import { VoiceboxUnavailable } from "../src/server/voicebox.js";

const audio = Buffer.alloc(8);

function fakes(opts: { voiceboxUp: boolean; groq?: boolean }) {
  const voicebox = {
    transcribe: vi.fn(async () => {
      if (!opts.voiceboxUp) throw new VoiceboxUnavailable("http://127.0.0.1:1", new Error("ECONNREFUSED"));
      return "from voicebox";
    }),
  };
  const groq = opts.groq === false ? null : { transcribe: vi.fn(async () => "from groq") };
  const log = vi.fn();
  return { voicebox, groq, log };
}

describe("createTranscriber", () => {
  it("auto: uses Voicebox when it answers and never touches Groq", async () => {
    const d = fakes({ voiceboxUp: true });
    const t = createTranscriber({ sttEngine: "auto" }, d);
    expect(await t.transcribe({ audio })).toBe("from voicebox");
    expect(d.groq!.transcribe).not.toHaveBeenCalled();
    expect(t.lastEngine()).toBe("voicebox");
  });

  it("auto: falls back to Groq per chunk when Voicebox is not running, logging once", async () => {
    const d = fakes({ voiceboxUp: false });
    const t = createTranscriber({ sttEngine: "auto" }, d);
    expect(await t.transcribe({ audio })).toBe("from groq");
    expect(await t.transcribe({ audio })).toBe("from groq");
    expect(d.voicebox.transcribe).toHaveBeenCalledTimes(2);
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.log.mock.calls[0][0]).toMatch(/Voicebox is not running/);
    expect(t.lastEngine()).toBe("groq");
  });

  it("auto: a Voicebox error that is not 'unavailable' propagates instead of going to the cloud", async () => {
    const d = fakes({ voiceboxUp: true });
    d.voicebox.transcribe.mockRejectedValueOnce(new Error("Voicebox responded 500"));
    const t = createTranscriber({ sttEngine: "auto" }, d);
    await expect(t.transcribe({ audio })).rejects.toThrow(/500/);
    expect(d.groq!.transcribe).not.toHaveBeenCalled();
  });

  it("auto: with no Groq key the fallback is a named error, not a silent empty line", async () => {
    const d = fakes({ voiceboxUp: false, groq: false });
    const t = createTranscriber({ sttEngine: "auto" }, d);
    await expect(t.transcribe({ audio })).rejects.toThrow(/GROQ_API_KEY/);
  });

  it("voicebox: never falls back, even when unavailable", async () => {
    const d = fakes({ voiceboxUp: false });
    const t = createTranscriber({ sttEngine: "voicebox" }, d);
    await expect(t.transcribe({ audio })).rejects.toBeInstanceOf(VoiceboxUnavailable);
    expect(d.groq!.transcribe).not.toHaveBeenCalled();
  });

  it("groq: never tries Voicebox", async () => {
    const d = fakes({ voiceboxUp: true });
    const t = createTranscriber({ sttEngine: "groq" }, d);
    expect(await t.transcribe({ audio })).toBe("from groq");
    expect(d.voicebox.transcribe).not.toHaveBeenCalled();
  });
});
