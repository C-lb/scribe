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
 * 2. Distance one, gated three ways: only for terms of four characters or
 *    more (so a three-letter term like "cap" can never fuzzy-claim "cat"),
 *    only when the token was not already an exact match for some term (tier
 *    1 already returned in that case), and only when the token's first
 *    letter matches the term's first letter.
 *
 *    That last gate is not in the brief's pinned cases, but it closes a real
 *    hole: without it, an ordinary English word one substitution away from a
 *    term gets silently renamed. "daft" is one substitution from "Raft"
 *    (d->r) and is a real word a lecturer might actually say. Whisper's own
 *    drift, by contrast, clips or garbles the *tail* of a word far more often
 *    than the head ("RAF" for "Raft" keeps the leading R), so requiring the
 *    first letter to match keeps the fix aimed at that failure mode instead
 *    of at coincidental near-misses. See tests/glossary.test.ts for the
 *    "daft" case this guards against.
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
      if (levenshtein(lower, termLower) === 1) return term;
    }
    return word;
  });
}
