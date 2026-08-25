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
  return isHallucination(text) ? "" : text;
}
