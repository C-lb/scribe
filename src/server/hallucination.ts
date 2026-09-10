/**
 * Backstop for Whisper's silence hallucinations.
 *
 * The real fix is the client-side energy gate in `web/audio/level.js`: a chunk
 * with no speech in it is never uploaded, so the model never gets the chance.
 * This catches what the gate cannot. A chunk that is *nearly* silent, someone
 * shuffling paper or a chair scraping, carries enough energy to pass the gate
 * and still contains no speech, and Whisper answers that with the same handful
 * of caption-corpus phrases it answers true silence with.
 *
 * Without this, one slip is not one bad line. `Session` feeds the transcript
 * tail back as the next chunk's bias prompt, so "Thank you." in the transcript
 * raises the prior for "Thank you." in the next chunk, and the phrase can walk
 * through a whole quiet stretch of a lecture. Dropping it here breaks the loop
 * at the point where it would otherwise be written down.
 *
 * The rule is deliberately timid: drop only when the *entire* chunk is one of
 * these phrases. A chunk that happens to contain "thank you" inside a real
 * sentence is a lecturer thanking someone, and is kept.
 */

/**
 * Phrases observed from `whisper-large-v3-turbo` on speechless audio. All are
 * artefacts of its training data (YouTube captions and subtitle files), not
 * things a lecturer says on their own for a whole chunk.
 */
const HALLUCINATIONS = [
  "thank you",
  "thank you very much",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching!",
  "please subscribe",
  "please subscribe to my channel",
  "like and subscribe",
  "don't forget to subscribe",
  "see you next time",
  "see you in the next video",
  "bye",
  "bye bye",
  "goodbye",
  "you",
  "music",
  "applause",
  "silence",
  "blank_audio",
  "subtitles by the amara.org community",
  "subtitles by amara.org community",
  "transcription by castingwords",
  "amara.org",
];

/**
 * The list is normalised on the way in, not written pre-normalised. "amara.org"
 * loses its dot to the punctuation strip, so a literal Set of the strings above
 * would silently never match the entries that contain punctuation, and the gap
 * would only show up as the artefact still appearing in a lecture.
 */
const KNOWN = new Set(HALLUCINATIONS.map(normalise));

/**
 * Strip what varies between two emissions of the same artefact, so the set
 * above stays a list of phrases rather than a list of spellings.
 *
 * Bracket and parenthesis markers ([Music], (applause), ♪♪) are unwrapped
 * rather than matched literally, because Whisper is inconsistent about which
 * wrapper it uses for the same event.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[\[\](){}♪*_]/g, " ")
    .replace(/[.,!?;:…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a chunk's whole transcript is a known silence artefact, or is
 * empty once punctuation is removed. Whisper returns a bare "." or "..." for
 * silence often enough to be worth naming.
 */
export function isHallucination(text: string): boolean {
  const normalised = normalise(text);
  if (normalised.length === 0) return true;
  return KNOWN.has(normalised);
}

/**
 * What the transcript should record for a chunk. Empty string means "write
 * nothing", which also keeps the phrase out of the next chunk's bias prompt.
 */
export function filterChunkText(text: string): string {
  const collapsed = collapseRepetitiveArtifacts(text);
  return isHallucination(collapsed) ? "" : collapsed;
}

/** Ported from Voicebox's `collapse_repetitive_artifacts`
 *  (backend/services/refinement.py, MIT). A 6-token repeat is almost never
 *  something a lecturer said; it is Whisper's decoder stuck in a loop. Six
 *  keeps rhetorical repetition ("no, no, no, no, no") intact. */
const REPETITION_RUN_THRESHOLD = 6;

/** Longest repeating unit the character pass looks for. Long enough for every
 *  loop phrase seen in the wild ("Please like and subscribe to my channel." is
 *  41 characters), short enough that a genuinely repeated sentence in speech
 *  stays below the run threshold. */
const MAX_REPETITION_UNIT_CHARS = 60;

/** Strip surrounding punctuation and case so "URL", "url," and "URL." compare
 *  equal inside a run. Unicode-aware so CJK tokens are not emptied. */
function tokenKey(word: string): string {
  return word.replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase();
}

function collapseWordRuns(text: string, minRun: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < minRun) return text;

  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    const key = tokenKey(words[i]);
    let j = i;
    if (key) {
      while (j < words.length && tokenKey(words[j]) === key) j += 1;
    } else {
      // An all-punctuation token never starts a run.
      j = i + 1;
    }
    if (j - i < minRun) out.push(...words.slice(i, j));
    i = j;
  }
  return out.join(" ");
}

function collapseCharacterRuns(text: string, minRun: number): string {
  // Non-greedy unit so the shortest repeating substring wins; a 2-character
  // floor leaves emphasis like "wooooooow" alone. [\s\S] rather than a dotAll
  // flag so a newline inside a looped unit still matches.
  const pattern = new RegExp(
    `([\\s\\S]{2,${MAX_REPETITION_UNIT_CHARS}}?)\\1{${minRun - 1},}`,
    "g",
  );
  const result = text.replace(pattern, "");
  if (result === text) return text;
  // Only normalise whitespace when something was removed, so untouched
  // transcripts keep their own spacing.
  return result.replace(/\s+/g, " ").trim();
}

/**
 * Remove Whisper's loop artefacts: a token repeated six or more times in a
 * row ("URL URL URL URL URL URL"), or a 2 to 60 character unit repeated six or
 * more times back to back ("thanks for watching " x 6, "謝謝觀看" x 7). The
 * word pass handles the first shape and normalises punctuation between
 * repeats; the character pass handles multi-word and CJK loops where no two
 * consecutive tokens are identical.
 *
 * The whole run is dropped rather than reduced to one copy. The prose either
 * side still carries the thought, and one surviving "thanks for watching"
 * would go straight back into the next chunk's bias prompt.
 */
export function collapseRepetitiveArtifacts(
  text: string,
  minRun: number = REPETITION_RUN_THRESHOLD,
): string {
  return collapseCharacterRuns(collapseWordRuns(text, minRun), minRun);
}
