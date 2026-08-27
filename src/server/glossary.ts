/**
 * A per-course term list that binds into transcription two ways: it biases
 * Whisper's next prompt (promptPrefix), and it corrects the transcript text
 * that comes back (correct). The correction runs before the corrected text
 * ever reaches the transcript, because the transcript's own tail is what
 * feeds the next chunk's prompt (see session.ts) -- a drifted word left
 * uncorrected would re-enter the bias prompt and compound.
 */

/**
 * Small local Levenshtein distance, iterative with a single rolling row so it
 * stays O(min(len)) in memory. No dependency: the whole function is a dozen
 * lines and the terms it compares are always short (course vocabulary, not
 * paragraphs).
 */
function levenshtein(a: string, b: string): number {
  const row = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) row[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let previousDiagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const previousRowJ = row[j];
      row[j] =
        a[i - 1] === b[j - 1]
          ? previousDiagonal
          : 1 + Math.min(previousDiagonal, row[j], row[j - 1]);
      previousDiagonal = previousRowJ;
    }
  }
  return row[b.length];
}

/**
 * The bias prompt Whisper sees before the trailing transcript. Built up to a
 * character budget rather than truncated afterward, so a term is either whole
 * or absent -- Whisper never sees half a word as a hint. Terminates in a
 * period because that is the sentence shape Whisper's prompt convention
 * expects (see Groq's docs on the `prompt` parameter).
 */
export function promptPrefix(terms: string[], maxChars = 160): string {
  let joined = "";
  for (const term of terms) {
    const candidate = joined ? `${joined}, ${term}` : term;
    if (`${candidate}.`.length > maxChars) break;
    joined = candidate;
  }
  return joined ? `${joined}.` : "";
}

/** Word tokens: letters, digits, and internal apostrophes. Everything else
 *  (punctuation, whitespace) is left in place by String.replace below, which
 *  is what keeps spacing and punctuation untouched and the token count fixed. */
const WORD = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;

/**
 * Two tiers, and the second is deliberately timid:
 *
 * 1. Exact, case-insensitive: a token whose lowercase form equals a term's
 *    lowercase form is replaced with the term's own spelling. Fixes "raft"
 *    to "Raft".
 * 2. Distance one, gated FOUR ways: only for terms of four characters or
 *    more (so a three-letter term like "cap" can never fuzzy-claim "cat"),
 *    only when the token was not already an exact match for some term (tier
 *    1 already returned in that case), only when the token's first letter
 *    matches the term's first letter, and only when the token and the term
 *    differ in LENGTH by exactly one.
 *
 *    Neither of the last two gates is in the brief's pinned cases, but both
 *    close real holes. The first-letter gate alone is not enough: "rapt" and
 *    "Raft" share a first letter and are one substitution apart (p<->f), and
 *    so are "Node" and "none". Both are ordinary English words a lecturer
 *    might actually say, and both are the same length as the term they would
 *    get renamed to.
 *
 *    The pinned case this feature exists for, "RAF" -> "Raft", is not a
 *    substitution: it is a DELETION, Whisper dropping a trailing letter, so
 *    the token is one character shorter than the term. That is the failure
 *    mode a bias prompt actually produces -- a clipped or garbled tail, not a
 *    same-length swap of one letter for another. A same-length substitution
 *    is overwhelmingly more likely to be a different real word than a
 *    mishearing of the term, and this file's whole premise is that a false
 *    correction is worse than a missed one, so the length gate restricts the
 *    fuzzy tier to insertions and deletions (length differs by exactly one)
 *    and leaves same-length substitutions alone even when they are distance
 *    one. See tests/glossary.test.ts for the "rapt" and "none" cases this
 *    guards against, and for the deliberate gap it leaves (a same-length
 *    substitution, and a term whose first letter was misheard, both stay
 *    uncorrected on purpose).
 */
export function correct(text: string, terms: string[]): string {
  if (terms.length === 0) return text;

  const exactByLower = new Map<string, string>();
  for (const term of terms) exactByLower.set(term.toLowerCase(), term);

  return text.replace(WORD, (word) => {
    const lower = word.toLowerCase();
    const exact = exactByLower.get(lower);
    if (exact !== undefined) return exact;

    for (const term of terms) {
      if (term.length < 4) continue;
      const termLower = term.toLowerCase();
      if (lower[0] !== termLower[0]) continue;
      if (Math.abs(lower.length - termLower.length) !== 1) continue;
      if (levenshtein(lower, termLower) === 1) return term;
    }
    return word;
  });
}
