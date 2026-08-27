import { describe, it, expect } from "vitest";
import { promptPrefix, correct } from "../src/server/glossary.js";

describe("promptPrefix", () => {
  it("joins terms into a phrase Whisper accepts as a prompt", () => {
    expect(promptPrefix(["Raft", "Paxos"])).toBe("Raft, Paxos.");
  });

  it("stops at the character budget rather than truncating a term", () => {
    expect(promptPrefix(["aaaa", "bbbb", "cccc"], 12)).toBe("aaaa, bbbb.");
  });

  it("is empty for no terms, so the caller can omit the prompt entirely", () => {
    expect(promptPrefix([])).toBe("");
  });
});

describe("correct", () => {
  it("restores a term that lost its capitalisation", () => {
    expect(correct("the raft protocol", ["Raft"])).toBe("the Raft protocol");
  });

  it("restores a term Whisper clipped a letter from", () => {
    expect(correct("makes RAF tolerant of partitions", ["Raft"])).toBe("makes Raft tolerant of partitions");
  });

  it("leaves a word alone when it is already another glossary term", () => {
    expect(correct("Paxos and Raft", ["Raft", "Paxos"])).toBe("Paxos and Raft");
  });

  it("does not touch a short term, where one letter of distance is a different word", () => {
    // "cap" is three letters, so fuzzy matching is off: "cat" stays a cat.
    expect(correct("the cat sat", ["cap"])).toBe("the cat sat");
  });

  it("only matches whole words", () => {
    expect(correct("drafting a note", ["Raft"])).toBe("drafting a note");
  });

  it("is a no-op with no terms", () => {
    expect(correct("anything at all", [])).toBe("anything at all");
  });

  // Not in the brief: found while hardening the fuzzy tier. "daft" is a real
  // word one substitution away from "Raft" (d -> r), the exact shape of edit
  // the distance-one tier is built to catch. Without a first-letter gate this
  // would silently turn an ordinary sentence into nonsense about a protocol
  // nobody mentioned. See the comment on correct() in glossary.ts.
  it("does not let an unrelated real word fuzzy-match a term across its first letter", () => {
    expect(correct("that plan is a bit daft", ["Raft"])).toBe("that plan is a bit daft");
  });

  // The first-letter gate alone was not enough: "rapt" and "Raft" share a
  // first letter and are one substitution apart, and so are "none" and
  // "Node". Both are ordinary English words a lecturer might say, and both
  // are the same length as the term they would otherwise get renamed to.
  // These pin the length gate that fixes it: only an insertion or deletion
  // (length differs by exactly one) qualifies for the fuzzy tier now, never
  // a same-length substitution.
  it("does not let 'rapt' fuzzy-match 'Raft', a same-length substitution that shares a first letter", () => {
    expect(correct("she was rapt with attention", ["Raft"])).toBe(
      "she was rapt with attention",
    );
  });

  it("does not let 'none' fuzzy-match 'Node', a same-length substitution that shares a first letter", () => {
    expect(correct("there were none available in the course repo", ["Node"])).toBe(
      "there were none available in the course repo",
    );
  });

  it("still restores a term Whisper clipped a letter from, the deletion the fuzzy tier exists for", () => {
    // Same case as above, restated here so the length-gate fix above cannot
    // silently regress the one thing this feature exists to catch: "RAF" is
    // one character SHORTER than "Raft" (a deletion), not a same-length
    // substitution, so the length gate lets it through.
    expect(correct("makes RAF tolerant of partitions", ["Raft"])).toBe(
      "makes Raft tolerant of partitions",
    );
  });

  // Deliberate gap, not a bug: catching either of these needs a dictionary
  // this codebase does not have (no new dependency allowed), and the whole
  // premise of the fuzzy tier is that a false correction is worse than a
  // missed one.
  it("intentionally leaves a first-letter mismatch and a same-length substitution uncorrected", () => {
    // First letter misheard: "lode" (a real word, a vein of ore) is one
    // substitution from "Node" (l <-> n) and the same length, so neither the
    // first-letter gate nor the length gate would let this through even if
    // only one of them existed.
    expect(correct("a lode of copper ore", ["Node"])).toBe("a lode of copper ore");
    // Restated from above: a same-length substitution that does share a
    // first letter is exactly the shape the length gate exists to block.
    expect(correct("she was rapt with attention", ["Raft"])).toBe(
      "she was rapt with attention",
    );
  });

  it("preserves punctuation and spacing exactly around a corrected token", () => {
    expect(correct("Is this raft, or something else?", ["Raft"])).toBe(
      "Is this Raft, or something else?",
    );
  });
});
