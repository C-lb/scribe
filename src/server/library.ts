import { readFile, writeFile, rename, unlink, mkdir, copyFile, readdir, access } from "node:fs/promises";
import path from "node:path";

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
  /**
   * The folder stays on disk untouched; this just removes it from the
   * rendered library. Deleting the entry instead cannot work: mergeLibrary
   * would rediscover the folder and show it again under Uncategorised on the
   * very next read.
   */
  hidden?: boolean;
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
  if (!isSessionId(id)) return id;
  const [year, month, day, hour, minute] = id.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}, ${hour}:${minute}`;
}

export function emptyLibrary(): LibraryFile {
  return { version: 1, categories: [], entries: {} };
}

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

export const UNCATEGORISED_ID = "uncategorised";

export interface SessionFolder {
  id: string;
  audioSeconds: number | null;
}

export interface SessionRow {
  id: string;
  title: string;
  named: boolean;
  live: boolean;
  audioSeconds: number | null;
}

export interface LibraryGroup {
  id: string;
  name: string;
  sessions: SessionRow[];
}

export interface LibraryView {
  categories: LibraryGroup[];
}

/**
 * The grouping and ordering live here rather than in the browser so they are
 * testable in Node. Folders are the source of truth for what exists; the
 * library file only says what the user decided about them.
 */
export function mergeLibrary(
  file: LibraryFile,
  folders: SessionFolder[],
  liveId: string | null,
): LibraryView {
  const categoryIds = new Set(file.categories.map((c) => c.id));
  const buckets = new Map<string, SessionRow[]>();
  for (const category of file.categories) buckets.set(category.id, []);
  buckets.set(UNCATEGORISED_ID, []);

  // Session order within a bucket comes from the entry; anything unordered
  // sorts after by id descending, so a fresh recording lands at the top.
  const ordered = [...folders].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  for (const folder of ordered) {
    const entry = file.entries[folder.id] ?? {};
    if (entry.hidden) continue;
    const bucketId =
      entry.categoryId && categoryIds.has(entry.categoryId) ? entry.categoryId : UNCATEGORISED_ID;
    const title = entry.title?.trim();
    buckets.get(bucketId)!.push({
      id: folder.id,
      title: title || defaultTitle(folder.id),
      named: Boolean(title),
      live: folder.id === liveId,
      audioSeconds: folder.id === liveId ? null : folder.audioSeconds,
    });
  }

  for (const rows of buckets.values()) {
    rows.sort((a, b) => {
      const orderA = file.entries[a.id]?.order;
      const orderB = file.entries[b.id]?.order;
      if (orderA === undefined && orderB === undefined) return 0; // already newest-first
      if (orderA === undefined) return 1;
      if (orderB === undefined) return -1;
      return orderA - orderB;
    });
  }

  const categories: LibraryGroup[] = [...file.categories]
    .sort((a, b) => a.order - b.order)
    .map((category) => ({
      id: category.id,
      name: category.name,
      sessions: buckets.get(category.id) ?? [],
    }));

  const loose = buckets.get(UNCATEGORISED_ID)!;
  if (loose.length > 0) {
    categories.push({ id: UNCATEGORISED_ID, name: "Uncategorised", sessions: loose });
  }

  return { categories };
}

function clone(file: LibraryFile): LibraryFile {
  return {
    version: 1,
    categories: file.categories.map((c) => ({ ...c })),
    entries: Object.fromEntries(Object.entries(file.entries).map(([id, e]) => [id, { ...e }])),
  };
}

function requireCategory(file: LibraryFile, id: string): void {
  if (!file.categories.some((c) => c.id === id)) {
    throw new Error(`unknown category: ${id}`);
  }
}

export function newCategoryId(random: () => number = Math.random): string {
  return `cat_${random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}

/**
 * Every mutation returns a new file rather than editing in place, so a
 * rejected payload cannot leave the in-memory copy half-applied.
 */
export function setEntry(
  file: LibraryFile,
  id: string,
  patch: { title?: string | null; categoryId?: string | null; hidden?: boolean | null },
): LibraryFile {
  if (!isSessionId(id)) throw new Error(`invalid session id: ${id}`);
  const next = clone(file);
  const entry = next.entries[id] ?? {};

  if (patch.title !== undefined) {
    const title = (patch.title ?? "").trim();
    if (title) entry.title = title;
    else delete entry.title;
  }

  if (patch.categoryId !== undefined) {
    if (patch.categoryId === null) {
      delete entry.categoryId;
    } else {
      requireCategory(next, patch.categoryId);
      entry.categoryId = patch.categoryId;
    }
  }

  if (patch.hidden !== undefined) {
    // true sets the flag; false or null removes it, so the entry does not
    // accumulate a dead `hidden: false`.
    if (patch.hidden) entry.hidden = true;
    else delete entry.hidden;
  }

  next.entries[id] = entry;
  return next;
}

export function createCategory(file: LibraryFile, name: string, id: string): LibraryFile {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("a category name cannot be empty");
  const next = clone(file);
  next.categories.push({ id, name: trimmed, order: next.categories.length });
  return next;
}

export function updateCategory(
  file: LibraryFile,
  id: string,
  patch: { name?: string; order?: number },
): LibraryFile {
  requireCategory(file, id);
  const next = clone(file);
  const category = next.categories.find((c) => c.id === id)!;
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error("a category name cannot be empty");
    category.name = trimmed;
  }
  if (patch.order !== undefined) {
    if (!Number.isInteger(patch.order)) throw new Error("order must be an integer");
    category.order = patch.order;
  }
  return next;
}

/** Never touches a session folder. Its sessions fall back to Uncategorised. */
export function deleteCategory(file: LibraryFile, id: string): LibraryFile {
  requireCategory(file, id);
  const next = clone(file);
  next.categories = next.categories
    .filter((c) => c.id !== id)
    .sort((a, b) => a.order - b.order)
    .map((c, index) => ({ ...c, order: index }));
  for (const entry of Object.values(next.entries)) {
    if (entry.categoryId === id) delete entry.categoryId;
  }
  return next;
}

export interface OrderPayload {
  groups: Array<{ categoryId: string | null; sessionIds: string[] }>;
  /** A completed heading drag. Every id must be a known category; Uncategorised
   *  is implicit and never appears here. Absent means "don't touch category order". */
  categoryIds?: string[];
}

/**
 * One drag renumbers several rows across two categories, so it arrives as one
 * payload. Validating every group before writing any of it means the library
 * cannot be left half-applied.
 */
export function applyOrder(file: LibraryFile, payload: OrderPayload): LibraryFile {
  for (const group of payload.groups) {
    if (group.categoryId !== null) requireCategory(file, group.categoryId);
    for (const id of group.sessionIds) {
      if (!isSessionId(id)) throw new Error(`invalid session id: ${id}`);
    }
  }
  if (payload.categoryIds) {
    for (const id of payload.categoryIds) requireCategory(file, id);
  }

  const next = clone(file);
  for (const group of payload.groups) {
    group.sessionIds.forEach((id, index) => {
      const entry = next.entries[id] ?? {};
      if (group.categoryId === null) delete entry.categoryId;
      else entry.categoryId = group.categoryId;
      entry.order = index;
      next.entries[id] = entry;
    });
  }

  if (payload.categoryIds) {
    // Ids omitted from the array are not dropped: they keep a stable relative
    // position, sorted by their existing order, after every listed id. That
    // way a partial payload never orphans a category out of view.
    const listed = payload.categoryIds;
    const listedSet = new Set(listed);
    const omitted = [...next.categories]
      .sort((a, b) => a.order - b.order)
      .filter((c) => !listedSet.has(c.id))
      .map((c) => c.id);
    const finalOrder = [...listed, ...omitted];
    const byId = new Map(next.categories.map((c) => [c.id, c]));
    next.categories = finalOrder.map((id, index) => ({ ...byId.get(id)!, order: index }));
  }

  return next;
}

/**
 * Generous: each file is a few kilobytes. The cap exists only so a machine
 * left running for months does not accumulate without limit.
 */
export const ARCHIVE_LIMIT = 30;

export function backupsDir(sessionsDir: string): string {
  return path.join(sessionsDir, ".library-backups");
}

export function rollbackPath(sessionsDir: string): string {
  return path.join(backupsDir(sessionsDir), "rollback.json");
}

function archiveDir(sessionsDir: string): string {
  return path.join(backupsDir(sessionsDir), "archive");
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function archive(sessionsDir: string, source: string, stamp: string): Promise<void> {
  const dir = archiveDir(sessionsDir);
  await mkdir(dir, { recursive: true });
  await copyFile(source, path.join(dir, `library-${stamp}.json`));

  const names = (await readdir(dir)).filter((n) => n.startsWith("library-")).sort();
  for (const name of names.slice(0, Math.max(0, names.length - ARCHIVE_LIMIT))) {
    await unlink(path.join(dir, name)).catch(() => {});
  }
}

/**
 * Taken once, at server start. The known limitation is that a long-running
 * Scribe has an old restore point; the archive is what makes intermediate
 * states recoverable by hand.
 */
export async function snapshotLibrary(sessionsDir: string, stamp: string): Promise<boolean> {
  const current = libraryPath(sessionsDir);
  if (!(await exists(current))) return false;

  await mkdir(backupsDir(sessionsDir), { recursive: true });
  const rollback = rollbackPath(sessionsDir);
  if (await exists(rollback)) await archive(sessionsDir, rollback, stamp);
  await copyFile(current, rollback);
  return true;
}

export async function hasRollback(sessionsDir: string): Promise<boolean> {
  return exists(rollbackPath(sessionsDir));
}

/** Archives the current file first, so a restore can be undone by hand. */
export async function restoreLibrary(sessionsDir: string, stamp: string): Promise<boolean> {
  const rollback = rollbackPath(sessionsDir);
  if (!(await exists(rollback))) return false;

  const current = libraryPath(sessionsDir);
  if (await exists(current)) await archive(sessionsDir, current, stamp);
  await copyFile(rollback, current);
  return true;
}
