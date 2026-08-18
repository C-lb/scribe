/** Category names, titles, and order. Never a record of what was recorded. */
export interface LibraryCategory {
  id: string;
  name: string;
  order: number;
}

export interface LibraryEntry {
  title?: string;
  categoryId?: string;
  order?: number;
}

export interface LibraryFile {
  version: 1;
  categories: LibraryCategory[];
  entries: Record<string, LibraryEntry>;
}

/** Exactly what Session.create builds: YYYY-MM-DD-HH-MM-SS. */
export const SESSION_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Derived, never stored: an unnamed session always shows its date, and
 * clearing a name in the UI reverts to it.
 */
export function defaultTitle(id: string): string {
  const match = SESSION_ID_PATTERN.exec(id);
  if (!match) return id;
  const [year, month, day, hour, minute] = id.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}, ${hour}:${minute}`;
}

export function emptyLibrary(): LibraryFile {
  return { version: 1, categories: [], entries: {} };
}

import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import path from "node:path";

export function libraryPath(sessionsDir: string): string {
  return path.join(sessionsDir, "library.json");
}

/**
 * A missing or corrupt file is not an error. The library is disposable by
 * design: losing it loses names and grouping, never a recording, so refusing
 * to start over a bad byte would be the worse failure.
 */
export async function readLibrary(sessionsDir: string): Promise<LibraryFile> {
  try {
    const raw = await readFile(libraryPath(sessionsDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<LibraryFile>;
    return {
      version: 1,
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
    };
  } catch {
    return emptyLibrary();
  }
}

/**
 * Atomic: serialise first, write to a temp file beside the target, then
 * rename over it. A crash mid-write leaves the previous file, not a truncated
 * one. Serialising before touching the filesystem means a bad object throws
 * before anything on disk has changed.
 */
export async function writeLibrary(
  sessionsDir: string,
  file: LibraryFile,
  knownIds: string[],
): Promise<void> {
  const known = new Set(knownIds);
  const entries: Record<string, LibraryEntry> = {};
  for (const [id, entry] of Object.entries(file.entries)) {
    if (known.has(id)) entries[id] = entry;
  }

  const body = JSON.stringify({ version: 1, categories: file.categories, entries }, null, 2);

  await mkdir(sessionsDir, { recursive: true });
  const target = libraryPath(sessionsDir);
  const temp = `${target}.tmp`;
  try {
    await writeFile(temp, `${body}\n`, "utf8");
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
