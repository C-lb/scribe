/**
 * Shared between the browser (summary and transcript export filenames) and
 * the server (the Content-Disposition filename on the caption routes), so
 * one slug rule governs every download this app produces. Plain string
 * work only, so it is safe to import from both a browser module and, via
 * allowJs, TypeScript server code.
 */
/**
 * The on-disk name of one chunk's WAV, zero-padded to four digits so a plain
 * string sort is also a chunk-index sort. One definition, because the writer
 * (session.ts), the two readers (audio-routes.ts) and the has-audio check
 * (library-routes.ts) all have to agree: a rename in one of them and not the
 * others silently breaks click-to-play with no error anywhere.
 */
export function chunkFileName(index) {
  return `${String(Number(index)).padStart(4, "0")}.wav`;
}

/** Matches exactly what chunkFileName produces, so a directory listing can be
 *  filtered to real chunks and nothing else (full.wav in particular). */
export const CHUNK_FILE_PATTERN = /^\d{4}\.wav$/;

export function sanitiseFilename(title, fallbackId) {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallbackId;
}
