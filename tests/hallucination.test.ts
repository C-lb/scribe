import { describe, it, expect } from "vitest";
import { isHallucination, filterChunkText, normalise } from "../src/server/hallucination.js";

describe("normalise", () => {
  it("folds case, punctuation and spacing", () => {
    expect(normalise("  Thank You!!  ")).toBe("thank you");
  });

  it("unwraps bracket and music markers", () => {
    // Whisper is inconsistent about which wrapper it uses for the same event,
    // so the phrase list stays a list of phrases rather than of spellings.
    expect(normalise("[Music]")).toBe("music");
    expect(normalise("(Applause)")).toBe("applause");
    expect(normalise("♪♪")).toBe("");
  });

  it("normalises curly apostrophes", () => {
    expect(normalise("Don’t forget to subscribe.")).toBe("don't forget to subscribe");
  });
});

describe("isHallucination", () => {
  it("catches the phrase this was built for", () => {
    expect(isHallucination("Thank you.")).toBe(true);
    expect(isHallucination(" thank you ")).toBe(true);
    expect(isHallucination("Thank you very much.")).toBe(true);
  });

  it("catches the rest of the caption-corpus set", () => {
    for (const text of [
      "Thanks for watching!",
      "Please subscribe to my channel",
      "[Music]",
      "(Applause)",
      "Subtitles by the Amara.org community",
      "Bye bye.",
      "You",
    ]) {
      expect(isHallucination(text), text).toBe(true);
    }
  });

  it("catches punctuation-only and empty output", () => {
    // Whisper returns a bare "." or "..." for silence often enough to name it.
    expect(isHallucination("")).toBe(true);
    expect(isHallucination("   ")).toBe(true);
    expect(isHallucination(".")).toBe(true);
    expect(isHallucination("...")).toBe(true);
  });

  it("keeps a real sentence that merely contains the phrase", () => {
    // A lecturer thanking someone is not an artefact. Dropping this would
    // delete real lecture content, which is strictly worse than the bug.
    expect(isHallucination("Thank you, that's a good question.")).toBe(false);
    expect(isHallucination("So thank you for staying late, let's continue.")).toBe(false);
    expect(isHallucination("I want to thank you all before we start.")).toBe(false);
  });

  it("keeps ordinary lecture text", () => {
    expect(isHallucination("The discount rate is applied to each cash flow.")).toBe(false);
    expect(isHallucination("Bye is also a word we use in computing, as in byte.")).toBe(false);
  });
});

describe("filterChunkText", () => {
  it("blanks an artefact so it never reaches the transcript", () => {
    expect(filterChunkText("Thank you.")).toBe("");
  });

  it("passes real text through byte for byte", () => {
    const text = "Semco removed the dress code first.";
    expect(filterChunkText(text)).toBe(text);
  });
});
