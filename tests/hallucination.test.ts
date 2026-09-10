import { describe, it, expect } from "vitest";
import {
  isHallucination,
  filterChunkText,
  normalise,
  collapseRepetitiveArtifacts,
} from "../src/server/hallucination.js";

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

/** Cases carried over from Voicebox's test_refinement_collapse.py so the port
 *  is pinned to the same behaviour, plus the two that matter for Scribe. */
describe("collapseRepetitiveArtifacts", () => {
  it("strips a single-word loop and normalises punctuation between repeats", () => {
    expect(collapseRepetitiveArtifacts("Hello " + "URL ".repeat(8).trim() + " goodbye")).toBe("Hello goodbye");
    expect(collapseRepetitiveArtifacts("Hello URL, URL, URL, URL, URL, URL. goodbye")).toBe("Hello goodbye");
    expect(collapseRepetitiveArtifacts("hi Url URL url Url URL url bye")).toBe("hi bye");
  });

  it("keeps rhetorical repetition below the threshold", () => {
    expect(collapseRepetitiveArtifacts("no no no no no")).toBe("no no no no no");
    expect(collapseRepetitiveArtifacts("I said no, no, no, no, no and she left")).toBe(
      "I said no, no, no, no, no and she left",
    );
  });

  it("strips a multi-word loop the word pass cannot see", () => {
    const raw = "Okay so the meeting is at three. " + "thanks for watching ".repeat(6);
    const out = collapseRepetitiveArtifacts(raw);
    expect(out).not.toContain("thanks for watching");
    expect(out).toContain("Okay so the meeting is at three");
    const five = "thanks for watching ".repeat(5).trim();
    expect(collapseRepetitiveArtifacts(five)).toBe(five);
  });

  it("strips a long phrase within the 60-character unit cap", () => {
    const unit = "Please like and subscribe to my channel. ";
    const out = collapseRepetitiveArtifacts("End of video. " + unit.repeat(6));
    expect(out).not.toContain(unit.trim());
    expect(out).toContain("End of video");
  });

  it("strips CJK loops with no whitespace and keeps short CJK runs", () => {
    const out = collapseRepetitiveArtifacts("會議在三點開始" + "謝謝觀看".repeat(7));
    expect(out).not.toContain("謝謝觀看");
    expect(out).toContain("會議在三點開始");
    expect(collapseRepetitiveArtifacts("好好好好好")).toBe("好好好好好");
  });

  it("leaves emphasis, short input and empty input alone", () => {
    expect(collapseRepetitiveArtifacts("that's wooooooow amazing")).toBe("that's wooooooow amazing");
    expect(collapseRepetitiveArtifacts("just three words")).toBe("just three words");
    expect(collapseRepetitiveArtifacts("")).toBe("");
  });

  it("honours a custom threshold", () => {
    const out = collapseRepetitiveArtifacts("ha ha ha ha context", 3);
    expect(out).not.toContain("ha ha");
    expect(out).toContain("context");
  });

  it("is applied by filterChunkText before the whole-chunk check", () => {
    // A loop that collapses to a bare artefact is dropped entirely, so it
    // never reaches the next chunk's bias prompt.
    expect(filterChunkText("thank you " + "thanks for watching ".repeat(6))).toBe("");
    expect(filterChunkText("The derivative is " + "URL ".repeat(7) + "zero here")).toBe(
      "The derivative is zero here",
    );
  });
});
