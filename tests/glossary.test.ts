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

  it("preserves punctuation and spacing exactly around a corrected token", () => {
    expect(correct("Is this raft, or something else?", ["Raft"])).toBe(
      "Is this Raft, or something else?",
    );
  });
});
