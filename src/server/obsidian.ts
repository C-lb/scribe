/**
 * Mirrors finished sessions into an Obsidian vault: one folder per library
 * category, one note per session, the summary and the transcript in the note.
 *
 * The vault is a projection, never a source of truth. Nothing here is ever
 * read back into Scribe, and a vault that is missing, read-only or on an
 * unmounted disk must never cost anyone a recording — every caller treats a
 * failure here as a log line, not an error.
 */
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSessionId, defaultTitle, readLibrary } from "./library.js";

/** Where sessions with no category land, mirroring the drawer's own wording. */
export const UNCATEGORISED_FOLDER = "Uncategorised";

/** Enough of a note's head to hold the frontmatter block we write. */
const FRONTMATTER_PROBE_BYTES = 512;

export interface NoteInput {
  id: string;
  title: string;
  /** null when the session is unfiled; the note still records a category. */
  categoryName: string | null;
  summaryMarkdown: string | null;
  transcript: string;
  audioSeconds?: number | null;
}

/**
 * Illegal or link-breaking in Obsidian, on macOS, or on both: the slash and
 * colon are filesystem-illegal, `#^[]|` break wikilinks, and the rest are
 * refused by Windows if the vault is ever synced. Replaced rather than
 * dropped, so "12:04" reads as "12-04" instead of collapsing to "1204".
 */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

/**
 * Obsidian's own note-title rules, not the download slug in shared/filename.js.
 * That one lowercases and strips to ASCII because it names a file leaving the
 * app; a vault note keeps the title the user actually typed, accents and all.
 */
export function noteFilename(title: string, fallbackId: string): string {
  const cleaned = String(title ?? "")
    .replace(ILLEGAL_FILENAME_CHARS, "-")
    // Control characters would be legal on disk and unreadable everywhere else.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    // A leading dot hides the note from Obsidian entirely; a trailing dot or
    // space is silently dropped by some filesystems and kept by others.
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    // Long enough for any real lecture title, short enough to leave room for
    // the folder path inside a 255-byte name limit.
    .slice(0, 120)
    .trim();
  return cleaned || fallbackId;
}

/** Same rules as a note name; a category is just a folder name. */
export function folderName(categoryName: string | null): string {
  if (categoryName === null) return UNCATEGORISED_FOLDER;
  return noteFilename(categoryName, UNCATEGORISED_FOLDER);
}

/** "2026-08-25-12-04-38" -> "2026-08-25 12:04". Anything else passes through. */
function readableDate(id: string): string {
  if (!isSessionId(id)) return id;
  const [year, month, day, hour, minute] = id.split("-");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function duration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(secs).padStart(2, "0")}s`;
}

/**
 * JSON's string escaping is a subset of YAML's double-quoted scalar, so a
 * title holding a colon, a quote or a backslash round-trips without any
 * quoting rules of our own.
 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Pushes every heading in the summary two levels down, so the model's own
 * `# Lecture Notes` sits under this note's `## Summary` instead of outranking
 * the note title. Without it Obsidian's outline reads the summary as a
 * sibling of the note rather than a section of it.
 *
 * Fenced code is left alone: a `# comment` inside a shell block is not a
 * heading, and demoting it would change the code.
 */
export function demoteHeadings(markdown: string, by = 2): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const match = /^(#{1,6})(\s)/.exec(line);
      if (!match) return line;
      // Six is as deep as Markdown goes; past it the hashes would render as
      // literal text.
      const level = Math.min(match[1].length + by, 6);
      return `${"#".repeat(level)}${line.slice(match[1].length)}`;
    })
    .join("\n");
}

export function buildNote(input: NoteInput): string {
  const front: string[] = [
    "---",
    `scribe_id: ${yamlString(input.id)}`,
    `title: ${yamlString(input.title)}`,
    `category: ${yamlString(input.categoryName ?? UNCATEGORISED_FOLDER)}`,
    `date: ${yamlString(readableDate(input.id))}`,
  ];
  const length = duration(input.audioSeconds);
  if (length) front.push(`duration: ${yamlString(length)}`);
  front.push("tags: [scribe]", "---");

  const body: string[] = [`# ${input.title}`];
  const summary = (input.summaryMarkdown ?? "").trim();
  // A session stopped before the final summary ran has none. Writing an empty
  // "## Summary" heading would look like the summary was lost rather than
  // never made, so the section is simply absent.
  if (summary) body.push("## Summary", demoteHeadings(summary));
  body.push("## Transcript", input.transcript.trim() || "_No transcript._");

  return `${front.join("\n")}\n\n${body.join("\n\n")}\n`;
}

/** The frontmatter id of a note, or null if this is not one of ours. */
async function noteSessionId(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(FRONTMATTER_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_PROBE_BYTES, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const match = /^scribe_id:\s*"([^"]+)"\s*$/m.exec(head);
    return match ? match[1] : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Every note under the Scribe root already written for this session.
 *
 * Found by reading frontmatter rather than by remembering the last path we
 * wrote: library.json is disposable by design, and a remembered path lost
 * with it would orphan the note and then duplicate it on the next rename.
 * Only the root and its immediate folders are walked, because that is the
 * only shape this module ever creates.
 */
async function existingNotes(root: string, id: string): Promise<string[]> {
  const found: string[] = [];
  let top;
  try {
    top = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  const files: string[] = [];
  for (const entry of top) {
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(path.join(root, entry.name));
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    try {
      for (const child of await readdir(dir, { withFileTypes: true })) {
        if (child.isFile() && child.name.endsWith(".md")) files.push(path.join(dir, child.name));
      }
    } catch {
      // An unreadable category folder just means we cannot clean up inside it.
    }
  }
  for (const file of files) {
    if ((await noteSessionId(file)) === id) found.push(file);
  }
  return found;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export interface ExportOptions {
  sessionsDir: string;
  /** The Scribe root inside the vault. null means the feature is off. */
  obsidianDir: string | null;
  id: string;
}

export interface ExportResult {
  /** Absolute path of the note written. */
  path: string;
  /** The same note as "Category/Note.md". What the status line shows: an
   *  absolute path is long enough to reflow the topbar around it, and the
   *  part anyone needs to find the note in Obsidian is the tail. */
  relativePath: string;
}

/**
 * Writes one session's note, moving it if its title or category has changed
 * since the last export. Returns null when no vault is configured — the
 * caller's cue that nothing was meant to happen, as opposed to a failure,
 * which throws.
 */
export async function exportSession(options: ExportOptions): Promise<ExportResult | null> {
  const { sessionsDir, obsidianDir, id } = options;
  if (!obsidianDir) return null;
  if (!isSessionId(id)) throw new Error(`invalid session id: ${id}`);

  const dir = path.join(sessionsDir, id);
  const transcript = await readText(path.join(dir, "transcript.md"));
  const summaryMarkdown = await readText(path.join(dir, "summary.md"));
  if (transcript === null && summaryMarkdown === null) {
    throw new Error(`session ${id} has nothing to export`);
  }

  let audioSeconds: number | null = null;
  const rawMeta = await readText(path.join(dir, "meta.json"));
  if (rawMeta) {
    try {
      const meta = JSON.parse(rawMeta) as { audioSeconds?: unknown };
      if (typeof meta.audioSeconds === "number") audioSeconds = meta.audioSeconds;
    } catch {
      // A half-written meta.json costs the note its duration line, nothing more.
    }
  }

  const library = await readLibrary(sessionsDir);
  const entry = library.entries[id] ?? {};
  const title = entry.title?.trim() || defaultTitle(id);
  const category = entry.categoryId
    ? (library.categories.find((c) => c.id === entry.categoryId)?.name ?? null)
    : null;

  const target = path.join(obsidianDir, folderName(category), `${noteFilename(title, id)}.md`);
  const note = buildNote({
    id,
    title,
    categoryName: category,
    summaryMarkdown,
    transcript: transcript ?? "",
    audioSeconds,
  });

  const stale = (await existingNotes(obsidianDir, id)).filter((file) => file !== target);

  await mkdir(path.dirname(target), { recursive: true });
  // Written beside the target and renamed over it: Obsidian watches the vault
  // and would otherwise index a half-written note.
  const tmp = `${target}.scribe-tmp`;
  await writeFile(tmp, note, "utf8");
  await rename(tmp, target);

  // Only after the new note is safely in place, so a failed write never
  // leaves the session with no note at all.
  for (const file of stale) {
    await unlink(file).catch((error) => {
      console.error(`[scribe] could not remove the old note ${file}:`, error);
    });
  }

  return { path: target, relativePath: path.relative(obsidianDir, target) };
}

/** The same export with every failure swallowed, for callers on a path where
 *  the vault must never be able to break anything: stopping a recording,
 *  renaming a session. */
export async function exportSessionQuietly(options: ExportOptions): Promise<void> {
  try {
    await exportSession(options);
  } catch (error) {
    console.error(`[scribe] Obsidian export failed for ${options.id}:`, error);
  }
}
