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
