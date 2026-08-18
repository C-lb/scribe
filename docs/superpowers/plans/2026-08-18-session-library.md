# Session Library and Summary Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browsable, organisable history of past recordings in a left drawer, and let any summary on screen be copied, saved, or shared.

**Architecture:** Session folders on disk stay the source of truth for what exists; a single `sessions/library.json` holds only the user's organisation (category names, titles, order) and is merged with the folder listing server-side, so the browser receives an already-grouped, already-ordered list. Nine new routes live in their own Express router rather than in `src/server/index.ts`. Browser code gains three small modules — sidebar rendering, drag maths, and summary export — each with the pure part split out and unit-tested.

**Tech Stack:** Node 20+, TypeScript (server), plain ES modules (browser, no bundler), Express 4, Vitest, `node:fs/promises`, `node:child_process.execFile`.

**Spec:** `docs/superpowers/specs/2026-08-18-session-library-design.md`

## Global Constraints

- **No npm package may enter browser code.** Everything under `src/web/` is hand-rolled plain ES modules loaded directly by the browser. No bundler, no imports from `node_modules`.
- **No new server dependencies.** Node builtins, `express`, `zod`, and the two SDKs already present. Nothing else.
- Server modules are TypeScript with `.js` extensions in import specifiers (`./library.js`), matching the existing code.
- Browser modules are `.js`, tested directly by Vitest importing the file (see `tests/resample.test.js` for the pattern).
- CSS uses only the tokens already declared in `src/web/styles.css` (Silver Gelatin). No new hues, no gradients, no shiny buttons. Headings render in `--ink-2`.
- Anti-vibecode standards apply to all UI: one accent, flat fills, 4px spacing scale, soft diffuse shadow, labels never wrap.
- Session id shape is exactly `YYYY-MM-DD-HH-MM-SS` (see `Session.create`). This is the validation pattern everywhere.
- All writes to `library.json` are atomic: write a temp file in the same directory, then `rename` over the target.
- Errors surface in the existing status line. No `alert`, `confirm`, or `prompt` — native dialogs block the page.
- Run `npm test` and `npm run typecheck` before each commit. Both must be clean.
- Commit after every task with a conventional-commit message.

---

### Task 1: Library types, id validation, default titles

**Files:**
- Create: `src/server/library.ts`
- Test: `tests/library.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface LibraryCategory { id: string; name: string; order: number }`
  - `interface LibraryEntry { title?: string; categoryId?: string; order?: number }`
  - `interface LibraryFile { version: 1; categories: LibraryCategory[]; entries: Record<string, LibraryEntry> }`
  - `const SESSION_ID_PATTERN: RegExp`
  - `function isSessionId(value: string): boolean`
  - `function defaultTitle(id: string): string`
  - `function emptyLibrary(): LibraryFile`

- [ ] **Step 1: Write the failing test**

Create `tests/library.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isSessionId, defaultTitle, emptyLibrary } from "../src/server/library.js";

describe("session ids", () => {
  it("accepts the id shape Session.create produces", () => {
    expect(isSessionId("2026-08-18-17-03-30")).toBe(true);
  });

  it("rejects traversal and anything outside the shape", () => {
    for (const bad of ["..", "../etc", "2026-08-18", "a/b", "2026-08-18-17-03-30/x", ""]) {
      expect(isSessionId(bad)).toBe(false);
    }
  });
});

describe("defaultTitle", () => {
  it("reads the date and time out of the id", () => {
    expect(defaultTitle("2026-08-18-17-03-30")).toBe("18 August 2026, 17:03");
  });

  it("returns the id unchanged when it is not a session id", () => {
    expect(defaultTitle("nonsense")).toBe("nonsense");
  });
});

describe("emptyLibrary", () => {
  it("is a valid version 1 file with nothing in it", () => {
    expect(emptyLibrary()).toEqual({ version: 1, categories: [], entries: {} });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/library.test.ts`
Expected: FAIL — cannot resolve `../src/server/library.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/library.ts`:

```ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/library.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/library.ts tests/library.test.ts docs/superpowers/specs/2026-08-18-session-library-design.md docs/superpowers/plans/2026-08-18-session-library.md
git commit -m "feat: library types, session id validation, and default titles"
```

---

### Task 2: Atomic read and write of library.json, with pruning

**Files:**
- Modify: `src/server/library.ts`
- Test: `tests/library.test.ts`

**Interfaces:**
- Consumes: `LibraryFile`, `emptyLibrary` from Task 1.
- Produces:
  - `function libraryPath(sessionsDir: string): string`
  - `async function readLibrary(sessionsDir: string): Promise<LibraryFile>`
  - `async function writeLibrary(sessionsDir: string, file: LibraryFile, knownIds: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

Append to `tests/library.test.ts`:

```ts
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLibrary, writeLibrary, libraryPath } from "../src/server/library.js";

async function dir() {
  return mkdtemp(path.join(tmpdir(), "scribe-library-"));
}

describe("readLibrary", () => {
  it("returns an empty library when the file does not exist", async () => {
    expect(await readLibrary(await dir())).toEqual({ version: 1, categories: [], entries: {} });
  });

  it("returns an empty library when the file is corrupt rather than throwing", async () => {
    const d = await dir();
    await writeFile(libraryPath(d), "{ not json", "utf8");
    expect(await readLibrary(d)).toEqual({ version: 1, categories: [], entries: {} });
  });

  it("reads back what was written", async () => {
    const d = await dir();
    await writeLibrary(
      d,
      {
        version: 1,
        categories: [{ id: "cat_a", name: "BUSI 520", order: 0 }],
        entries: { "2026-08-18-17-03-30": { title: "Raft", categoryId: "cat_a", order: 0 } },
      },
      ["2026-08-18-17-03-30"],
    );
    const file = await readLibrary(d);
    expect(file.categories[0].name).toBe("BUSI 520");
    expect(file.entries["2026-08-18-17-03-30"].title).toBe("Raft");
  });
});

describe("writeLibrary", () => {
  it("prunes entries whose session folder has vanished", async () => {
    const d = await dir();
    await writeLibrary(
      d,
      {
        version: 1,
        categories: [],
        entries: {
          "2026-08-18-17-03-30": { title: "kept" },
          "2026-01-01-09-00-00": { title: "gone" },
        },
      },
      ["2026-08-18-17-03-30"],
    );
    const file = await readLibrary(d);
    expect(Object.keys(file.entries)).toEqual(["2026-08-18-17-03-30"]);
  });

  it("leaves no temp file behind", async () => {
    const d = await dir();
    await writeLibrary(d, { version: 1, categories: [], entries: {} }, []);
    const names = await readdir(d);
    expect(names).toEqual(["library.json"]);
  });

  it("leaves the previous file intact when the write fails mid-way", async () => {
    const d = await dir();
    await writeLibrary(d, { version: 1, categories: [{ id: "cat_a", name: "first", order: 0 }], entries: {} }, []);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      writeLibrary(d, { version: 1, categories: [], entries: { x: circular as never } }, ["x"]),
    ).rejects.toThrow();

    const still = JSON.parse(await readFile(libraryPath(d), "utf8"));
    expect(still.categories[0].name).toBe("first");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/library.test.ts`
Expected: FAIL — `readLibrary is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/server/library.ts`:

```ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/library.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/library.ts tests/library.test.ts
git commit -m "feat: atomic library read and write with pruning of vanished sessions"
```

---

### Task 3: Merging the library with what is on disk

**Files:**
- Modify: `src/server/library.ts`
- Test: `tests/library.test.ts`

**Interfaces:**
- Consumes: `LibraryFile`, `defaultTitle` from Tasks 1–2.
- Produces:
  - `const UNCATEGORISED_ID = "uncategorised"`
  - `interface SessionFolder { id: string; audioSeconds: number | null }`
  - `interface SessionRow { id: string; title: string; named: boolean; live: boolean; audioSeconds: number | null }`
  - `interface LibraryGroup { id: string; name: string; sessions: SessionRow[] }`
  - `interface LibraryView { categories: LibraryGroup[] }`
  - `function mergeLibrary(file: LibraryFile, folders: SessionFolder[], liveId: string | null): LibraryView`

- [ ] **Step 1: Write the failing test**

Append to `tests/library.test.ts`:

```ts
import { mergeLibrary, UNCATEGORISED_ID } from "../src/server/library.js";

const folder = (id: string, audioSeconds: number | null = 60) => ({ id, audioSeconds });

describe("mergeLibrary", () => {
  it("puts folders the library does not mention under Uncategorised, newest first", () => {
    const view = mergeLibrary(
      { version: 1, categories: [], entries: {} },
      [folder("2026-01-01-09-00-00"), folder("2026-08-18-17-03-30")],
      null,
    );
    expect(view.categories).toHaveLength(1);
    expect(view.categories[0].id).toBe(UNCATEGORISED_ID);
    expect(view.categories[0].sessions.map((s) => s.id)).toEqual([
      "2026-08-18-17-03-30",
      "2026-01-01-09-00-00",
    ]);
  });

  it("gives an unnamed session its date as a title and marks it unnamed", () => {
    const view = mergeLibrary({ version: 1, categories: [], entries: {} }, [folder("2026-08-18-17-03-30")], null);
    const row = view.categories[0].sessions[0];
    expect(row.title).toBe("18 August 2026, 17:03");
    expect(row.named).toBe(false);
  });

  it("ignores entries whose folder is gone", () => {
    const view = mergeLibrary(
      { version: 1, categories: [], entries: { "2020-01-01-00-00-00": { title: "ghost" } } },
      [folder("2026-08-18-17-03-30")],
      null,
    );
    expect(view.categories[0].sessions.map((s) => s.id)).toEqual(["2026-08-18-17-03-30"]);
  });

  it("groups by category, orders categories by order, and sessions by order", () => {
    const view = mergeLibrary(
      {
        version: 1,
        categories: [
          { id: "cat_b", name: "BUSI 530", order: 1 },
          { id: "cat_a", name: "BUSI 520", order: 0 },
        ],
        entries: {
          "2026-08-18-17-03-30": { title: "Raft", categoryId: "cat_a", order: 1 },
          "2026-08-17-17-03-30": { title: "Paxos", categoryId: "cat_a", order: 0 },
          "2026-08-16-17-03-30": { title: "Beta", categoryId: "cat_b", order: 0 },
        },
      },
      [folder("2026-08-18-17-03-30"), folder("2026-08-17-17-03-30"), folder("2026-08-16-17-03-30")],
      null,
    );
    expect(view.categories.map((c) => c.name)).toEqual(["BUSI 520", "BUSI 530"]);
    expect(view.categories[0].sessions.map((s) => s.title)).toEqual(["Paxos", "Raft"]);
  });

  it("treats an unknown categoryId as Uncategorised", () => {
    const view = mergeLibrary(
      { version: 1, categories: [], entries: { "2026-08-18-17-03-30": { categoryId: "cat_missing" } } },
      [folder("2026-08-18-17-03-30")],
      null,
    );
    expect(view.categories[0].id).toBe(UNCATEGORISED_ID);
  });

  it("keeps an empty category visible so it can be dropped into", () => {
    const view = mergeLibrary(
      { version: 1, categories: [{ id: "cat_a", name: "BUSI 520", order: 0 }], entries: {} },
      [],
      null,
    );
    expect(view.categories.map((c) => c.name)).toEqual(["BUSI 520"]);
    expect(view.categories[0].sessions).toEqual([]);
  });

  it("marks the recording session live and hides its duration", () => {
    const view = mergeLibrary(
      { version: 1, categories: [], entries: {} },
      [folder("2026-08-18-17-03-30", null)],
      "2026-08-18-17-03-30",
    );
    const row = view.categories[0].sessions[0];
    expect(row.live).toBe(true);
    expect(row.audioSeconds).toBeNull();
  });

  it("drops Uncategorised entirely when every session has a home", () => {
    const view = mergeLibrary(
      {
        version: 1,
        categories: [{ id: "cat_a", name: "BUSI 520", order: 0 }],
        entries: { "2026-08-18-17-03-30": { categoryId: "cat_a", order: 0 } },
      },
      [folder("2026-08-18-17-03-30")],
      null,
    );
    expect(view.categories.map((c) => c.id)).toEqual(["cat_a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/library.test.ts`
Expected: FAIL — `mergeLibrary is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/server/library.ts`:

```ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/library.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/library.ts tests/library.test.ts
git commit -m "feat: merge library organisation with session folders on disk"
```

---

### Task 4: Library mutations — titles, categories, and bulk reorder

**Files:**
- Modify: `src/server/library.ts`
- Test: `tests/library.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces (all pure, operating on and returning a `LibraryFile`):
  - `function setEntry(file: LibraryFile, id: string, patch: { title?: string | null; categoryId?: string | null }): LibraryFile`
  - `function createCategory(file: LibraryFile, name: string, id: string): LibraryFile`
  - `function updateCategory(file: LibraryFile, id: string, patch: { name?: string; order?: number }): LibraryFile`
  - `function deleteCategory(file: LibraryFile, id: string): LibraryFile`
  - `interface OrderPayload { groups: Array<{ categoryId: string | null; sessionIds: string[] }> }`
  - `function applyOrder(file: LibraryFile, payload: OrderPayload): LibraryFile`
  - `function newCategoryId(random?: () => number): string`

- [ ] **Step 1: Write the failing test**

Append to `tests/library.test.ts`:

```ts
import {
  setEntry, createCategory, updateCategory, deleteCategory, applyOrder, newCategoryId,
} from "../src/server/library.js";

const base = () => ({
  version: 1 as const,
  categories: [{ id: "cat_a", name: "BUSI 520", order: 0 }],
  entries: { "2026-08-18-17-03-30": { title: "Raft", categoryId: "cat_a", order: 0 } },
});

describe("setEntry", () => {
  it("sets a title", () => {
    const file = setEntry(base(), "2026-08-17-17-03-30", { title: "Paxos" });
    expect(file.entries["2026-08-17-17-03-30"].title).toBe("Paxos");
  });

  it("clearing a title removes it so the date default returns", () => {
    const file = setEntry(base(), "2026-08-18-17-03-30", { title: "   " });
    expect(file.entries["2026-08-18-17-03-30"].title).toBeUndefined();
  });

  it("a null categoryId moves the session to Uncategorised", () => {
    const file = setEntry(base(), "2026-08-18-17-03-30", { categoryId: null });
    expect(file.entries["2026-08-18-17-03-30"].categoryId).toBeUndefined();
  });

  it("does not mutate the input", () => {
    const input = base();
    setEntry(input, "2026-08-18-17-03-30", { title: "changed" });
    expect(input.entries["2026-08-18-17-03-30"].title).toBe("Raft");
  });

  it("rejects a categoryId that does not exist", () => {
    expect(() => setEntry(base(), "2026-08-18-17-03-30", { categoryId: "cat_nope" })).toThrow(
      /unknown category/,
    );
  });
});

describe("categories", () => {
  it("creates one at the end of the order", () => {
    const file = createCategory(base(), "BUSI 530", "cat_b");
    expect(file.categories.map((c) => [c.id, c.order])).toEqual([
      ["cat_a", 0],
      ["cat_b", 1],
    ]);
  });

  it("rejects an empty name", () => {
    expect(() => createCategory(base(), "  ", "cat_b")).toThrow(/name/);
  });

  it("renames one", () => {
    const file = updateCategory(base(), "cat_a", { name: "Distributed systems" });
    expect(file.categories[0].name).toBe("Distributed systems");
  });

  it("reorders one", () => {
    const two = createCategory(base(), "BUSI 530", "cat_b");
    const file = updateCategory(two, "cat_b", { order: 0 });
    expect(file.categories.find((c) => c.id === "cat_b")!.order).toBe(0);
  });

  it("deleting one leaves its sessions alone but unfiled", () => {
    const file = deleteCategory(base(), "cat_a");
    expect(file.categories).toEqual([]);
    expect(file.entries["2026-08-18-17-03-30"]).toBeDefined();
    expect(file.entries["2026-08-18-17-03-30"].categoryId).toBeUndefined();
  });

  it("throws on an unknown category", () => {
    expect(() => deleteCategory(base(), "cat_nope")).toThrow(/unknown category/);
  });

  it("mints ids that fit the cat_ shape", () => {
    expect(newCategoryId(() => 0.5)).toMatch(/^cat_[a-z0-9]{6}$/);
  });
});

describe("applyOrder", () => {
  it("applies a drag across two categories in one payload", () => {
    let file = createCategory(base(), "BUSI 530", "cat_b");
    file = setEntry(file, "2026-08-17-17-03-30", { title: "Paxos", categoryId: "cat_a" });

    file = applyOrder(file, {
      groups: [
        { categoryId: "cat_a", sessionIds: ["2026-08-17-17-03-30"] },
        { categoryId: "cat_b", sessionIds: ["2026-08-18-17-03-30"] },
      ],
    });

    expect(file.entries["2026-08-17-17-03-30"]).toMatchObject({ categoryId: "cat_a", order: 0 });
    expect(file.entries["2026-08-18-17-03-30"]).toMatchObject({ categoryId: "cat_b", order: 0 });
  });

  it("a null categoryId group unfiles its sessions and still orders them", () => {
    const file = applyOrder(base(), {
      groups: [{ categoryId: null, sessionIds: ["2026-08-18-17-03-30"] }],
    });
    expect(file.entries["2026-08-18-17-03-30"].categoryId).toBeUndefined();
    expect(file.entries["2026-08-18-17-03-30"].order).toBe(0);
  });

  it("keeps the title when a session moves", () => {
    const file = applyOrder(base(), {
      groups: [{ categoryId: null, sessionIds: ["2026-08-18-17-03-30"] }],
    });
    expect(file.entries["2026-08-18-17-03-30"].title).toBe("Raft");
  });

  it("rejects the whole payload if any category is unknown, changing nothing", () => {
    const input = base();
    expect(() =>
      applyOrder(input, { groups: [{ categoryId: "cat_nope", sessionIds: [] }] }),
    ).toThrow(/unknown category/);
    expect(input.entries["2026-08-18-17-03-30"].categoryId).toBe("cat_a");
  });

  it("rejects a session id outside the id shape", () => {
    expect(() =>
      applyOrder(base(), { groups: [{ categoryId: null, sessionIds: ["../etc/passwd"] }] }),
    ).toThrow(/session id/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/library.test.ts`
Expected: FAIL — `setEntry is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/server/library.ts`:

```ts
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
  patch: { title?: string | null; categoryId?: string | null },
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
  return next;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/library.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/library.ts tests/library.test.ts
git commit -m "feat: library mutations for titles, categories, and bulk reorder"
```

---

### Task 5: Rollback snapshot, archive, and restore

**Files:**
- Modify: `src/server/library.ts`
- Test: `tests/library.test.ts`

**Interfaces:**
- Consumes: `readLibrary`, `writeLibrary`, `libraryPath` from Task 2.
- Produces:
  - `const ARCHIVE_LIMIT = 30`
  - `function backupsDir(sessionsDir: string): string`
  - `function rollbackPath(sessionsDir: string): string`
  - `async function snapshotLibrary(sessionsDir: string, stamp: string): Promise<boolean>`
  - `async function restoreLibrary(sessionsDir: string, stamp: string): Promise<boolean>`
  - `async function hasRollback(sessionsDir: string): Promise<boolean>`

`stamp` is passed in rather than read from the clock so the tests can assert on
archive filenames. Callers pass `new Date().toISOString().replace(/[:.]/g, "-")`.

- [ ] **Step 1: Write the failing test**

Append to `tests/library.test.ts`:

```ts
import {
  snapshotLibrary, restoreLibrary, hasRollback, rollbackPath, backupsDir, ARCHIVE_LIMIT,
} from "../src/server/library.js";

const named = (name: string) => ({ version: 1 as const, categories: [{ id: "cat_a", name, order: 0 }], entries: {} });

describe("rollback", () => {
  it("does nothing and reports false when there is no library yet", async () => {
    const d = await dir();
    expect(await snapshotLibrary(d, "stamp-1")).toBe(false);
    expect(await hasRollback(d)).toBe(false);
  });

  it("snapshots the library as it was when Scribe opened", async () => {
    const d = await dir();
    await writeLibrary(d, named("at open"), []);
    expect(await snapshotLibrary(d, "stamp-1")).toBe(true);

    await writeLibrary(d, named("changed since"), []);
    const snapshot = JSON.parse(await readFile(rollbackPath(d), "utf8"));
    expect(snapshot.categories[0].name).toBe("at open");
  });

  it("archives the previous snapshot before overwriting it", async () => {
    const d = await dir();
    await writeLibrary(d, named("first open"), []);
    await snapshotLibrary(d, "stamp-1");
    await writeLibrary(d, named("second open"), []);
    await snapshotLibrary(d, "stamp-2");

    const archived = await readdir(path.join(backupsDir(d), "archive"));
    expect(archived).toEqual(["library-stamp-2.json"]);
    const previous = JSON.parse(
      await readFile(path.join(backupsDir(d), "archive", "library-stamp-2.json"), "utf8"),
    );
    expect(previous.categories[0].name).toBe("first open");
  });

  it("prunes the archive to the most recent 30", async () => {
    const d = await dir();
    await writeLibrary(d, named("v0"), []);
    for (let i = 0; i <= ARCHIVE_LIMIT + 3; i += 1) {
      await snapshotLibrary(d, `stamp-${String(i).padStart(3, "0")}`);
      await writeLibrary(d, named(`v${i + 1}`), []);
    }
    const archived = await readdir(path.join(backupsDir(d), "archive"));
    expect(archived).toHaveLength(ARCHIVE_LIMIT);
    expect(archived.sort()[0]).not.toBe("library-stamp-000.json");
  });

  it("restores the snapshot after archiving the current file, so a restore is undoable", async () => {
    const d = await dir();
    await writeLibrary(d, named("at open"), []);
    await snapshotLibrary(d, "stamp-1");
    await writeLibrary(d, named("a mess"), []);

    expect(await restoreLibrary(d, "stamp-restore")).toBe(true);
    expect((await readLibrary(d)).categories[0].name).toBe("at open");

    const archived = await readdir(path.join(backupsDir(d), "archive"));
    expect(archived).toContain("library-stamp-restore.json");
    const undo = JSON.parse(
      await readFile(path.join(backupsDir(d), "archive", "library-stamp-restore.json"), "utf8"),
    );
    expect(undo.categories[0].name).toBe("a mess");
  });

  it("reports false from restore when there is no snapshot", async () => {
    expect(await restoreLibrary(await dir(), "stamp-1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/library.test.ts`
Expected: FAIL — `snapshotLibrary is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/server/library.ts` (extend the `node:fs/promises` import at the top of the file to include `copyFile`, `readdir`, and `access`):

```ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/library.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/library.ts tests/library.test.ts
git commit -m "feat: library rollback snapshot, archive, and restore"
```

---

### Task 6: Persist the running summary and expose whether a session is recording

**Files:**
- Modify: `src/server/session.ts:116-167`
- Test: `tests/session.test.ts`

**Why:** reading a past session must be able to fall back to the last running
summary when the final summary failed — which is not hypothetical, it happened
during this project's own verification. Running summaries are currently only
published over SSE and never written down. `isRecording` is what the library
list uses to mark the live row.

**Interfaces:**
- Consumes: `Session` as it exists.
- Produces: `Session.isRecording: boolean` (public getter, `true` until `stop()` resolves) and a `running-summary.json` file written into the session directory after every successful running summary.

- [ ] **Step 1: Write the failing test**

Append to `tests/session.test.ts` (follow the existing helper style in that file for building a `Session` against a temp dir and stub deps):

```ts
it("writes the running summary to disk so a failed final summary still has something to show", async () => {
  const { session, dir } = await makeSession({
    running: vi.fn().mockResolvedValue({
      topics: ["Raft"], keyPoints: [], definitions: [], flagged: [], openQuestions: [],
    }),
    final: vi.fn().mockRejectedValue(new Error("overloaded")),
  });

  await session.ingestChunk({ index: 1, startMs: 0, endMs: 20_000, audio: Buffer.from("wav") });
  await session.stop();

  const saved = JSON.parse(await readFile(path.join(dir, "running-summary.json"), "utf8"));
  expect(saved.topics).toEqual(["Raft"]);
});

it("reports that it is recording until stop resolves", async () => {
  const { session } = await makeSession();
  expect(session.isRecording).toBe(true);
  await session.stop();
  expect(session.isRecording).toBe(false);
});
```

If `makeSession` does not already let the test force a summary immediately, pass
`now` so the summary interval has elapsed — the existing tests in this file
already use that lever; reuse it rather than inventing a second one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL — no `running-summary.json`, and `isRecording` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/server/session.ts`, add the field and the write:

```ts
  private recording = true;

  get isRecording(): boolean {
    return this.recording;
  }
```

In `maybeSummarise`, after `this.events.publish({ type: "summary", summary: this.summary })`:

```ts
      // Persisted so a session whose final summary failed still has something
      // to display and to export. Failing to write it must not stop the
      // recording, so it is caught here rather than propagating.
      await writeFile(
        path.join(this.dir, "running-summary.json"),
        `${JSON.stringify(this.summary, null, 2)}\n`,
        "utf8",
      ).catch((error) => console.error("[scribe] failed to save running summary:", error));
```

In `stop()`, set `this.recording = false;` immediately before `return markdown;`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/session.ts tests/session.test.ts
git commit -m "feat: persist running summaries and expose session recording state"
```

---

### Task 7: Library routes — reading the library and a saved session

**Files:**
- Create: `src/server/library-routes.ts`
- Create: `tests/library-routes.test.ts`

**Interfaces:**
- Consumes: everything exported from `src/server/library.ts`; `Config` from `./config.js`.
- Produces:
  - `interface LibraryRouterDeps { config: Config; liveSessionId: () => string | null; now?: () => string }`
  - `function createLibraryRouter(deps: LibraryRouterDeps): express.Router`
  - Routes in this task: `GET /api/library`, `GET /api/sessions/:id`.

`now` returns the archive stamp string and defaults to
`() => new Date().toISOString().replace(/[:.]/g, "-")`.

`GET /api/library` responds `{ categories, canRestore }`.
`GET /api/sessions/:id` responds `{ id, title, transcript, summaryMarkdown, runningSummary, meta }`,
where `summaryMarkdown` is `null` if `summary.md` is missing or blank, and
`runningSummary` is `null` if `running-summary.json` is missing or unparseable.

- [ ] **Step 1: Write the failing test**

Create `tests/library-routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { loadConfig } from "../src/server/config.js";
import { createLibraryRouter } from "../src/server/library-routes.js";

async function serve(liveId: string | null = null) {
  const dir = await mkdtemp(path.join(tmpdir(), "scribe-routes-"));
  const config = loadConfig({
    GROQ_API_KEY: "gsk_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    SCRIBE_SESSIONS_DIR: dir,
  } as NodeJS.ProcessEnv);

  const app = express();
  app.use(createLibraryRouter({ config, liveSessionId: () => liveId }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, dir, server };
}

async function seed(dir: string, id: string, files: Record<string, string> = {}) {
  await mkdir(path.join(dir, id), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, id, name), body, "utf8");
  }
}

describe("GET /api/library", () => {
  it("lists folders it has never seen under Uncategorised", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30");

    const body = await (await fetch(`${base}/api/library`)).json();
    expect(body.categories[0].id).toBe("uncategorised");
    expect(body.categories[0].sessions[0].title).toBe("18 August 2026, 17:03");
    expect(body.canRestore).toBe(false);
    server.close();
  });

  it("ignores non-session directories and stray files", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30");
    await mkdir(path.join(dir, ".library-backups"), { recursive: true });
    await writeFile(path.join(dir, "library.json"), "{}", "utf8");

    const body = await (await fetch(`${base}/api/library`)).json();
    const ids = body.categories.flatMap((c: { sessions: { id: string }[] }) => c.sessions.map((s) => s.id));
    expect(ids).toEqual(["2026-08-18-17-03-30"]);
    server.close();
  });

  it("reads the duration out of meta.json and marks the live session", async () => {
    const { base, dir, server } = await serve("2026-08-18-18-00-00");
    await seed(dir, "2026-08-18-17-03-30", { "meta.json": JSON.stringify({ audioSeconds: 1800 }) });
    await seed(dir, "2026-08-18-18-00-00");

    const body = await (await fetch(`${base}/api/library`)).json();
    const rows: { id: string; live: boolean; audioSeconds: number | null }[] =
      body.categories[0].sessions;
    expect(rows.find((r) => r.id === "2026-08-18-17-03-30")).toMatchObject({
      live: false, audioSeconds: 1800,
    });
    expect(rows.find((r) => r.id === "2026-08-18-18-00-00")).toMatchObject({
      live: true, audioSeconds: null,
    });
    server.close();
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns the transcript and the final summary", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30", {
      "transcript.md": "00:00 hello world\n",
      "summary.md": "# Notes\n\nSomething.\n",
      "meta.json": JSON.stringify({ audioSeconds: 60 }),
    });

    const body = await (await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).json();
    expect(body.transcript).toContain("hello world");
    expect(body.summaryMarkdown).toContain("# Notes");
    expect(body.title).toBe("18 August 2026, 17:03");
    expect(body.meta.audioSeconds).toBe(60);
    server.close();
  });

  it("falls back to the running summary when the final summary failed", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30", {
      "transcript.md": "00:00 hello\n",
      "running-summary.json": JSON.stringify({
        topics: ["Raft"], keyPoints: [], definitions: [], flagged: [], openQuestions: [],
      }),
    });

    const body = await (await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).json();
    expect(body.summaryMarkdown).toBeNull();
    expect(body.runningSummary.topics).toEqual(["Raft"]);
    server.close();
  });

  it("treats an empty summary file the same as a missing one", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30", { "transcript.md": "x", "summary.md": "   \n" });

    const body = await (await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).json();
    expect(body.summaryMarkdown).toBeNull();
    server.close();
  });

  it("400s an id outside the id shape and 404s one that does not exist", async () => {
    const { base, server } = await serve();
    expect((await fetch(`${base}/api/sessions/..`)).status).toBe(400);
    expect((await fetch(`${base}/api/sessions/2026-08-18-17-03-30`)).status).toBe(404);
    server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/library-routes.test.ts`
Expected: FAIL — cannot resolve `../src/server/library-routes.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/library-routes.ts`:

```ts
import express from "express";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import {
  isSessionId,
  defaultTitle,
  readLibrary,
  mergeLibrary,
  hasRollback,
  type SessionFolder,
} from "./library.js";

export interface LibraryRouterDeps {
  config: Config;
  liveSessionId: () => string | null;
  now?: () => string;
}

async function listFolders(sessionsDir: string): Promise<string[]> {
  try {
    const items = await readdir(sessionsDir, { withFileTypes: true });
    return items.filter((i) => i.isDirectory() && isSessionId(i.name)).map((i) => i.name);
  } catch {
    return [];
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    const raw = await readFile(file, "utf8");
    return raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

async function describeFolders(sessionsDir: string, ids: string[]): Promise<SessionFolder[]> {
  return Promise.all(
    ids.map(async (id) => {
      const meta = await readJson<{ audioSeconds?: number }>(
        path.join(sessionsDir, id, "meta.json"),
      );
      return { id, audioSeconds: typeof meta?.audioSeconds === "number" ? meta.audioSeconds : null };
    }),
  );
}

export function createLibraryRouter(deps: LibraryRouterDeps): express.Router {
  const router = express.Router();
  const { sessionsDir } = deps.config;

  router.get("/api/library", async (_req, res) => {
    try {
      const ids = await listFolders(sessionsDir);
      const file = await readLibrary(sessionsDir);
      const view = mergeLibrary(file, await describeFolders(sessionsDir, ids), deps.liveSessionId());
      res.json({ ...view, canRestore: await hasRollback(sessionsDir) });
    } catch (error) {
      console.error("[scribe] failed to read the library:", error);
      res.status(500).json({ error: "internal error" });
    }
  });

  router.get("/api/sessions/:id", async (req, res) => {
    const { id } = req.params;
    if (!isSessionId(id)) return res.status(400).json({ error: "invalid session id" });

    const dir = path.join(sessionsDir, id);
    const transcript = await readText(path.join(dir, "transcript.md"));
    const meta = await readJson<Record<string, unknown>>(path.join(dir, "meta.json"));
    const summaryMarkdown = await readText(path.join(dir, "summary.md"));
    const runningSummary = await readJson<unknown>(path.join(dir, "running-summary.json"));

    if (transcript === null && meta === null && summaryMarkdown === null && runningSummary === null) {
      return res.status(404).json({ error: "unknown session" });
    }

    const file = await readLibrary(sessionsDir);
    const title = file.entries[id]?.title?.trim() || defaultTitle(id);
    res.json({ id, title, transcript: transcript ?? "", summaryMarkdown, runningSummary, meta });
  });

  return router;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/library-routes.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/library-routes.ts tests/library-routes.test.ts
git commit -m "feat: routes for reading the library and a saved session"
```

---

### Task 8: Library routes — writing titles, categories, order, and restore

**Files:**
- Modify: `src/server/library-routes.ts`
- Test: `tests/library-routes.test.ts`

**Interfaces:**
- Consumes: the mutation functions from Task 4 and the rollback functions from Task 5.
- Produces routes: `PATCH /api/sessions/:id`, `POST /api/categories`, `PATCH /api/categories/:id`, `DELETE /api/categories/:id`, `PUT /api/library/order`, `POST /api/library/restore`. Each write responds with the same shape as `GET /api/library` so the browser can re-render from one payload.

- [ ] **Step 1: Write the failing test**

Append to `tests/library-routes.test.ts`:

```ts
const json = (base: string, method: string, url: string, body?: unknown) =>
  fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("library writes", () => {
  it("renames a session and returns the re-rendered library", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30");

    const res = await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "Raft" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.categories[0].sessions[0].title).toBe("Raft");
    expect(body.categories[0].sessions[0].named).toBe(true);
    server.close();
  });

  it("clearing a title reverts the row to its date", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30");
    await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "Raft" });

    const body = await (await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "" })).json();
    expect(body.categories[0].sessions[0].title).toBe("18 August 2026, 17:03");
    server.close();
  });

  it("creates, renames, and deletes a category without touching the recording", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30");

    const created = await (await json(base, "POST", "/api/categories", { name: "BUSI 520" })).json();
    const id = created.categories[0].id;
    expect(created.categories[0].name).toBe("BUSI 520");

    await json(base, "PATCH", `/api/sessions/2026-08-18-17-03-30`, { categoryId: id });
    const renamed = await (await json(base, "PATCH", `/api/categories/${id}`, { name: "Distributed" })).json();
    expect(renamed.categories[0].name).toBe("Distributed");

    const deleted = await (await json(base, "DELETE", `/api/categories/${id}`)).json();
    expect(deleted.categories[0].id).toBe("uncategorised");
    expect(deleted.categories[0].sessions[0].id).toBe("2026-08-18-17-03-30");
    server.close();
  });

  it("400s an unknown category rather than half-applying it", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30");
    const res = await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { categoryId: "cat_nope" });
    expect(res.status).toBe(400);
    server.close();
  });

  it("applies a whole drag as one payload", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30");
    await seed(dir, "2026-08-17-17-03-30");
    const created = await (await json(base, "POST", "/api/categories", { name: "BUSI 520" })).json();
    const id = created.categories[0].id;

    const body = await (
      await json(base, "PUT", "/api/library/order", {
        groups: [
          { categoryId: id, sessionIds: ["2026-08-17-17-03-30", "2026-08-18-17-03-30"] },
        ],
      })
    ).json();

    expect(body.categories[0].sessions.map((s: { id: string }) => s.id)).toEqual([
      "2026-08-17-17-03-30",
      "2026-08-18-17-03-30",
    ]);
    server.close();
  });

  it("400s a malformed order payload", async () => {
    const { base, server } = await serve();
    expect((await json(base, "PUT", "/api/library/order", { groups: "nope" })).status).toBe(400);
    server.close();
  });

  it("restores the library to the snapshot taken at start", async () => {
    const { base, dir, server } = await serve();
    await seed(dir, "2026-08-18-17-03-30");
    await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "before" });

    const { snapshotLibrary } = await import("../src/server/library.js");
    await snapshotLibrary(dir, "stamp-open");

    await json(base, "PATCH", "/api/sessions/2026-08-18-17-03-30", { title: "after" });
    const body = await (await json(base, "POST", "/api/library/restore")).json();
    expect(body.categories[0].sessions[0].title).toBe("before");
    server.close();
  });

  it("409s a restore when no snapshot exists", async () => {
    const { base, server } = await serve();
    expect((await json(base, "POST", "/api/library/restore")).status).toBe(409);
    server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/library-routes.test.ts`
Expected: FAIL — the PATCH route 404s.

- [ ] **Step 3: Write minimal implementation**

Extend the imports in `src/server/library-routes.ts` to bring in `writeLibrary`,
`setEntry`, `createCategory`, `updateCategory`, `deleteCategory`, `applyOrder`,
`newCategoryId`, `restoreLibrary`, `type LibraryFile`, and `type OrderPayload`,
then add:

```ts
  router.use(express.json({ limit: "256kb" }));

  const stamp = deps.now ?? (() => new Date().toISOString().replace(/[:.]/g, "-"));

  /** Every write answers with the whole re-rendered library, so the browser
   *  never has to reconstruct what the server just decided. */
  async function respondWithLibrary(res: express.Response): Promise<void> {
    const ids = await listFolders(sessionsDir);
    const file = await readLibrary(sessionsDir);
    const view = mergeLibrary(file, await describeFolders(sessionsDir, ids), deps.liveSessionId());
    res.json({ ...view, canRestore: await hasRollback(sessionsDir) });
  }

  /** A rejected mutation is the user's mistake, not a server fault: 400 with
   *  the reason, which the browser puts straight into the status line. */
  async function mutate(
    res: express.Response,
    change: (file: LibraryFile) => LibraryFile | Promise<LibraryFile>,
  ): Promise<void> {
    try {
      const ids = await listFolders(sessionsDir);
      const next = await change(await readLibrary(sessionsDir));
      await writeLibrary(sessionsDir, next, ids);
      await respondWithLibrary(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "bad request";
      console.error("[scribe] library write rejected:", error);
      res.status(400).json({ error: message });
    }
  }

  router.patch("/api/sessions/:id", async (req, res) => {
    const { id } = req.params;
    if (!isSessionId(id)) return res.status(400).json({ error: "invalid session id" });

    const patch: { title?: string | null; categoryId?: string | null } = {};
    if ("title" in req.body) patch.title = req.body.title === null ? null : String(req.body.title);
    if ("categoryId" in req.body) {
      patch.categoryId = req.body.categoryId === null ? null : String(req.body.categoryId);
    }
    await mutate(res, (file) => setEntry(file, id, patch));
  });

  router.post("/api/categories", async (req, res) => {
    await mutate(res, (file) => createCategory(file, String(req.body?.name ?? ""), newCategoryId()));
  });

  router.patch("/api/categories/:id", async (req, res) => {
    const patch: { name?: string; order?: number } = {};
    if ("name" in req.body) patch.name = String(req.body.name);
    if ("order" in req.body) patch.order = Number(req.body.order);
    await mutate(res, (file) => updateCategory(file, req.params.id, patch));
  });

  router.delete("/api/categories/:id", async (req, res) => {
    await mutate(res, (file) => deleteCategory(file, req.params.id));
  });

  router.put("/api/library/order", async (req, res) => {
    const groups = req.body?.groups;
    if (!Array.isArray(groups)) return res.status(400).json({ error: "groups must be an array" });
    for (const group of groups) {
      if (!group || !Array.isArray(group.sessionIds)) {
        return res.status(400).json({ error: "each group needs sessionIds" });
      }
    }
    const payload: OrderPayload = {
      groups: groups.map((g) => ({
        categoryId: g.categoryId == null ? null : String(g.categoryId),
        sessionIds: g.sessionIds.map(String),
      })),
    };
    await mutate(res, (file) => applyOrder(file, payload));
  });

  router.post("/api/library/restore", async (_req, res) => {
    try {
      const restored = await restoreLibrary(sessionsDir, stamp());
      if (!restored) return res.status(409).json({ error: "there is nothing to restore to" });
      await respondWithLibrary(res);
    } catch (error) {
      console.error("[scribe] restore failed:", error);
      res.status(500).json({ error: "internal error" });
    }
  });
```

Note the ordering constraint: `router.get("/api/sessions/:id")` from Task 7 and
`router.patch("/api/sessions/:id")` do not collide, but this router is mounted
alongside the session routes in `index.ts` in Task 10 — the existing routes are
all `POST` or a `GET` on `/events`, so nothing shadows anything. Confirm with
`npm test` that `tests/server.test.ts` still passes after Task 10.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/library-routes.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/library-routes.ts tests/library-routes.test.ts
git commit -m "feat: library write routes for titles, categories, order, and restore"
```

---

### Task 9: Reveal in Finder — the one dangerous surface

**Files:**
- Modify: `src/server/library-routes.ts`
- Test: `tests/library-routes.test.ts`

**Interfaces:**
- Consumes: `isSessionId`.
- Produces: `POST /api/sessions/:id/reveal`, and a `reveal` field on `LibraryRouterDeps`: `reveal?: (dir: string) => Promise<void>`, defaulting to an `execFile("open", [dir])` wrapper. Injecting it is what lets the test assert on the argument without opening Finder windows.

- [ ] **Step 1: Write the failing test**

Append to `tests/library-routes.test.ts`:

```ts
import { vi } from "vitest";

describe("POST /api/sessions/:id/reveal", () => {
  async function serveWithReveal() {
    const dir = await mkdtemp(path.join(tmpdir(), "scribe-reveal-"));
    const config = loadConfig({
      GROQ_API_KEY: "gsk_test",
      ANTHROPIC_API_KEY: "sk-ant-test",
      SCRIBE_SESSIONS_DIR: dir,
    } as NodeJS.ProcessEnv);
    const reveal = vi.fn().mockResolvedValue(undefined);
    const app = express();
    app.use(createLibraryRouter({ config, liveSessionId: () => null, reveal }));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    return { base: `http://127.0.0.1:${port}`, dir, server, reveal };
  }

  it("opens the session folder", async () => {
    const { base, dir, server, reveal } = await serveWithReveal();
    await seed(dir, "2026-08-18-17-03-30");

    const res = await fetch(`${base}/api/sessions/2026-08-18-17-03-30/reveal`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(reveal).toHaveBeenCalledWith(path.join(dir, "2026-08-18-17-03-30"));
    server.close();
  });

  it("rejects traversal, separators, and anything outside the id shape without shelling out", async () => {
    const { base, server, reveal } = await serveWithReveal();
    for (const bad of ["..", "%2e%2e", "2026-08-18-17-03-30%2F..", "a;open%20-a%20Calculator"]) {
      const res = await fetch(`${base}/api/sessions/${bad}/reveal`, { method: "POST" });
      expect(res.status).toBe(400);
    }
    expect(reveal).not.toHaveBeenCalled();
    server.close();
  });

  it("404s a session folder that does not exist", async () => {
    const { base, server, reveal } = await serveWithReveal();
    const res = await fetch(`${base}/api/sessions/2026-08-18-17-03-30/reveal`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(reveal).not.toHaveBeenCalled();
    server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/library-routes.test.ts`
Expected: FAIL — the reveal route 404s.

- [ ] **Step 3: Write minimal implementation**

Add to the top of `src/server/library-routes.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";

const run = promisify(execFile);

/**
 * The path goes in as an array element, never interpolated into a shell
 * string, so shell metacharacters have no meaning even if the id validation
 * above were somehow bypassed. Belt and braces, deliberately.
 */
async function openInFinder(dir: string): Promise<void> {
  await run("open", [dir]);
}
```

Add `reveal?: (dir: string) => Promise<void>` to `LibraryRouterDeps`, then inside
`createLibraryRouter`:

```ts
  const reveal = deps.reveal ?? openInFinder;

  router.post("/api/sessions/:id/reveal", async (req, res) => {
    const { id } = req.params;
    // Two gates: the id shape, then the resolved path. Either alone would
    // probably do; this is the one route where user input reaches the OS.
    if (!isSessionId(id)) return res.status(400).json({ error: "invalid session id" });

    const dir = path.resolve(sessionsDir, id);
    const root = path.resolve(sessionsDir);
    if (dir !== path.join(root, id) || !dir.startsWith(`${root}${path.sep}`)) {
      return res.status(400).json({ error: "invalid session id" });
    }

    try {
      const info = await stat(dir);
      if (!info.isDirectory()) return res.status(404).json({ error: "unknown session" });
    } catch {
      return res.status(404).json({ error: "unknown session" });
    }

    try {
      await reveal(dir);
      res.json({});
    } catch (error) {
      console.error("[scribe] reveal failed:", error);
      res.status(500).json({ error: "could not open the folder" });
    }
  });
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/library-routes.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/library-routes.ts tests/library-routes.test.ts
git commit -m "feat: reveal a session folder in Finder, with strict id validation"
```

---

### Task 10: Mount the router and snapshot the library at start

**Files:**
- Modify: `src/server/index.ts:14-117`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `createLibraryRouter` (Task 7–9), `snapshotLibrary` (Task 5), `Session.isRecording` (Task 6).
- Produces: `createApp` mounts the library router before the static handler; the CLI entry point awaits `snapshotLibrary` before `listen`.

- [ ] **Step 1: Write the failing test**

Append to `tests/server.test.ts`:

```ts
it("serves the library alongside the recording routes", async () => {
  const { base, server } = await app();
  const res = await fetch(`${base}/api/library`);
  expect(res.status).toBe(200);
  expect((await res.json()).categories).toEqual([]);
  server.close();
});

it("marks the session it is currently recording as live", async () => {
  const { base, server } = await app();
  const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();

  const before = await (await fetch(`${base}/api/library`)).json();
  expect(before.categories[0].sessions[0]).toMatchObject({ id, live: true });

  await fetch(`${base}/api/sessions/${id}/stop`, { method: "POST" });
  const after = await (await fetch(`${base}/api/library`)).json();
  expect(after.categories[0].sessions[0].live).toBe(false);
  server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — `/api/library` falls through to the static handler and 404s.

- [ ] **Step 3: Write minimal implementation**

In `src/server/index.ts`, import the router and mount it inside `createApp`,
immediately before `app.use(express.static(webRoot))`:

```ts
  // Only one recording runs at a time in practice; take the most recent one
  // still marked as recording so the list can flag the live row.
  const liveSessionId = () => {
    for (const [id, session] of [...sessions].reverse()) {
      if (session.isRecording) return id;
    }
    return null;
  };

  app.use(createLibraryRouter({ config, liveSessionId }));
```

In the CLI block at the bottom, before `listen`:

```ts
  // The restore point is the library as it was when Scribe was opened. Taken
  // before the first request is served, so nothing can change underneath it.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await snapshotLibrary(config.sessionsDir, stamp);
```

The CLI block is not currently async. Wrap the snapshot and `listen` in an
immediately-invoked async function, keeping the existing `unhandledRejection`
handler registered first:

```ts
  void (async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await snapshotLibrary(config.sessionsDir, stamp);
    createApp(config, deps).listen(config.port, () => {
      console.log(`[scribe] listening on http://localhost:${config.port}`);
    });
  })();
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — the whole suite, including the pre-existing server tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts tests/server.test.ts
git commit -m "feat: mount the library router and snapshot the library at start"
```

---

### Task 11: Summary to plain text, and the filename sanitiser

**Files:**
- Create: `src/web/summary-export.js`
- Test: `tests/summary-export.test.js`

**Why the conversion is one function:** a running summary is structured data
and a final summary is Claude-authored Markdown, but both must end at the same
chat-friendly plain text — a summary pasted into WhatsApp should read like
something a person wrote, not like a file with `##` and `**` in it.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function summaryToPlainText(input)` where `input` is `{ kind: "running", summary }` or `{ kind: "markdown", markdown }`; returns a string.
  - `function sanitiseFilename(title, fallbackId)` returns a string.

- [ ] **Step 1: Write the failing test**

Create `tests/summary-export.test.js`:

```js
import { describe, it, expect } from "vitest";
import { summaryToPlainText, sanitiseFilename } from "../src/web/summary-export.js";

const running = (over = {}) => ({
  topics: [], keyPoints: [], definitions: [], flagged: [], openQuestions: [], ...over,
});

describe("summaryToPlainText, running summaries", () => {
  it("renders every populated section with bullets", () => {
    const text = summaryToPlainText({
      kind: "running",
      summary: running({
        topics: ["Consensus"],
        keyPoints: ["Quorums overlap"],
        definitions: [{ term: "Quorum", definition: "A majority of nodes" }],
        flagged: ["On the exam"],
        openQuestions: ["What about partitions?"],
      }),
    });

    expect(text).toBe(
      [
        "Topics",
        "• Consensus",
        "",
        "Key points",
        "• Quorums overlap",
        "",
        "Definitions",
        "• Quorum — A majority of nodes",
        "",
        "Flagged",
        "• On the exam",
        "",
        "Open questions",
        "• What about partitions?",
      ].join("\n"),
    );
  });

  it("omits empty sections rather than printing bare headings", () => {
    const text = summaryToPlainText({ kind: "running", summary: running({ topics: ["Only this"] }) });
    expect(text).toBe("Topics\n• Only this");
  });

  it("returns an empty string for a summary with nothing in it", () => {
    expect(summaryToPlainText({ kind: "running", summary: running() })).toBe("");
  });
});

describe("summaryToPlainText, markdown summaries", () => {
  it("flattens headings, bullets, and inline emphasis", () => {
    const markdown = [
      "# Lecture notes",
      "",
      "## Overview",
      "",
      "The lecture covered **consensus** and *quorums*.",
      "",
      "- First point",
      "- Second point",
      "  - A nested one",
      "",
      "1. Numbered too",
    ].join("\n");

    expect(summaryToPlainText({ kind: "markdown", markdown })).toBe(
      [
        "Lecture notes",
        "",
        "Overview",
        "",
        "The lecture covered consensus and quorums.",
        "",
        "• First point",
        "• Second point",
        "  ◦ A nested one",
        "",
        "• Numbered too",
      ].join("\n"),
    );
  });

  it("strips code fences and inline code markers", () => {
    expect(summaryToPlainText({ kind: "markdown", markdown: "Use `raft` here" })).toBe("Use raft here");
  });

  it("collapses runs of blank lines to one", () => {
    expect(summaryToPlainText({ kind: "markdown", markdown: "A\n\n\n\nB" })).toBe("A\n\nB");
  });

  it("returns an empty string for empty or whitespace-only markdown", () => {
    expect(summaryToPlainText({ kind: "markdown", markdown: "   \n\n" })).toBe("");
  });
});

describe("sanitiseFilename", () => {
  it("lowercases and hyphenates a title", () => {
    expect(sanitiseFilename("Raft and Consensus", "2026-08-18-17-03-30")).toBe("raft-and-consensus");
  });

  it("drops characters outside letters, digits, hyphens, and underscores", () => {
    expect(sanitiseFilename("BUSI 520: Week #3 (draft)", "id")).toBe("busi-520-week-3-draft");
  });

  it("falls back to the session id when the title sanitises down to nothing", () => {
    expect(sanitiseFilename("←→", "2026-08-18-17-03-30")).toBe("2026-08-18-17-03-30");
    expect(sanitiseFilename("", "2026-08-18-17-03-30")).toBe("2026-08-18-17-03-30");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/summary-export.test.js`
Expected: FAIL — cannot resolve `../src/web/summary-export.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/summary-export.js`:

```js
/**
 * One conversion feeds Copy, Save, and Share. Two inputs, one output: a
 * running summary is structured data, a final summary is Claude's Markdown,
 * and both end as text a person can paste into a chat window.
 */

function collapseBlankRuns(lines) {
  const out = [];
  for (const line of lines) {
    if (line === "" && out[out.length - 1] === "") continue;
    out.push(line);
  }
  return out;
}

/** Emphasis and code markers only. Structure is handled before this runs. */
function stripInline(text) {
  return text
    .replace(/`+/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .trim();
}

function fromRunning(summary) {
  const sections = [
    ["Topics", summary.topics ?? []],
    ["Key points", summary.keyPoints ?? []],
    [
      "Definitions",
      (summary.definitions ?? []).map(({ term, definition }) => `${term} — ${definition}`),
    ],
    ["Flagged", summary.flagged ?? []],
    ["Open questions", summary.openQuestions ?? []],
  ];

  const blocks = [];
  for (const [title, items] of sections) {
    if (!items.length) continue;
    blocks.push([title, ...items.map((item) => `• ${item}`)].join("\n"));
  }
  return blocks.join("\n\n");
}

function fromMarkdown(markdown) {
  const lines = [];
  for (const raw of String(markdown).split("\n")) {
    // Structure first, emphasis second: stripping `*` first would eat the
    // bullet marker at the start of a line.
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      lines.push(stripInline(heading[1]));
      continue;
    }

    const bullet = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (bullet) {
      const depth = Math.floor(bullet[1].length / 2);
      const marker = depth === 0 ? "•" : "◦";
      lines.push(`${"  ".repeat(depth)}${marker} ${stripInline(bullet[2])}`);
      continue;
    }

    if (/^\s*(```|~~~)/.test(raw)) continue;
    lines.push(stripInline(raw));
  }
  return collapseBlankRuns(lines).join("\n").trim();
}

export function summaryToPlainText(input) {
  if (!input) return "";
  if (input.kind === "running") return fromRunning(input.summary ?? {});
  if (input.kind === "markdown") return fromMarkdown(input.markdown ?? "");
  return "";
}

export function sanitiseFilename(title, fallbackId) {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallbackId;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/summary-export.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/summary-export.js tests/summary-export.test.js
git commit -m "feat: plain-text summary conversion and filename sanitiser"
```

---

### Task 12: Copy, Save, and Share controls

**Files:**
- Modify: `src/web/summary-export.js`
- Modify: `src/web/index.html:26-31`
- Modify: `src/web/styles.css` (append)
- Modify: `src/web/app.js`

**Interfaces:**
- Consumes: `summaryToPlainText`, `sanitiseFilename` from Task 11.
- Produces: `function createExportControls({ root, getSummary, setStatus })` returning `{ refresh() }`.
  `getSummary()` returns `{ input, title, sessionId, recording }` where `input` is
  the `summaryToPlainText` argument or `null`, and `recording` decides which
  sentence a disabled control shows.
- `function exportState({ input, recording })` returns `{ enabled, reason }`.
- `function buildMarkdownFile({ title, sessionId, markdown })` returns `{ name, text }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/summary-export.test.js`:

```js
import { buildMarkdownFile, exportState } from "../src/web/summary-export.js";

describe("exportState", () => {
  it("is disabled and explains itself while the first summary is still coming", () => {
    expect(exportState({ input: null, recording: true })).toEqual({
      enabled: false,
      reason: "The first summary appears after about five minutes.",
    });
  });

  it("is disabled and honest when a finished session has no summary at all", () => {
    expect(exportState({ input: null, recording: false })).toEqual({
      enabled: false,
      reason: "The summary for this session failed, so there is nothing to send.",
    });
  });

  it("is enabled once there is any summary", () => {
    expect(exportState({ input: { kind: "markdown", markdown: "# x" }, recording: false })).toEqual({
      enabled: true,
      reason: "",
    });
  });
});

describe("buildMarkdownFile", () => {
  it("names the file from the title and leads with it as a heading", () => {
    const file = buildMarkdownFile({
      title: "Raft and Consensus",
      sessionId: "2026-08-18-17-03-30",
      markdown: "## Overview\n\nSomething.\n",
    });
    expect(file.name).toBe("raft-and-consensus.md");
    expect(file.text).toBe("# Raft and Consensus\n\n## Overview\n\nSomething.\n");
  });

  it("does not repeat a heading the markdown already opens with", () => {
    const file = buildMarkdownFile({
      title: "Raft",
      sessionId: "id",
      markdown: "# Raft\n\nBody.\n",
    });
    expect(file.text).toBe("# Raft\n\nBody.\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/summary-export.test.js`
Expected: FAIL — `exportState is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/web/summary-export.js`:

```js
/** No dead buttons: either the control works, or it says why it does not. */
export function exportState({ input, recording }) {
  if (input) return { enabled: true, reason: "" };
  return {
    enabled: false,
    reason: recording
      ? "The first summary appears after about five minutes."
      : "The summary for this session failed, so there is nothing to send.",
  };
}

export function buildMarkdownFile({ title, sessionId, markdown }) {
  const body = String(markdown ?? "");
  const heading = `# ${title}`;
  const text = body.trimStart().startsWith("#") ? body : `${heading}\n\n${body}`;
  return { name: `${sanitiseFilename(title, sessionId)}.md`, text };
}

/**
 * Copy, Save, and Share. Share only exists where the browser has the API:
 * a button that fails when pressed is worse than one that was never there.
 */
export function createExportControls({ root, getSummary, setStatus }) {
  const copyButton = root.querySelector("#summary-copy");
  const saveButton = root.querySelector("#summary-save");
  const shareButton = root.querySelector("#summary-share");
  const summaryEl = document.getElementById("summary");

  shareButton.hidden = typeof navigator.share !== "function";

  function refresh() {
    const { input, recording } = getSummary();
    const { enabled, reason } = exportState({ input, recording });
    for (const button of [copyButton, saveButton, shareButton]) {
      button.disabled = !enabled;
      button.title = reason;
    }
  }

  copyButton.addEventListener("click", async () => {
    const { input } = getSummary();
    const text = summaryToPlainText(input);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Summary copied");
    } catch (error) {
      // Failing to a state the user can rescue beats failing to a message.
      console.error("[scribe] clipboard write refused", error);
      const range = document.createRange();
      range.selectNodeContents(summaryEl);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      setStatus("Could not reach the clipboard — the summary is selected, press Cmd-C");
    }
  });

  saveButton.addEventListener("click", () => {
    const { input, title, sessionId } = getSummary();
    const markdown =
      input.kind === "markdown" ? input.markdown : summaryToPlainText(input);
    const file = buildMarkdownFile({ title, sessionId, markdown });

    const url = URL.createObjectURL(new Blob([file.text], { type: "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(`Saved ${file.name}`);
  });

  shareButton.addEventListener("click", async () => {
    const { input, title, sessionId } = getSummary();
    const text = summaryToPlainText(input);
    const markdown = input.kind === "markdown" ? input.markdown : text;
    const built = buildMarkdownFile({ title, sessionId, markdown });

    // Built before the call and shared without an intervening await: the API
    // requires a user gesture and rejects once the gesture has been spent.
    const file = new File([built.text], built.name, { type: "text/markdown" });
    const payload =
      typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })
        ? { files: [file], title }
        : { text, title };

    try {
      await navigator.share(payload);
    } catch (error) {
      // Cancelling is a normal outcome, not a failure to report.
      if (error && error.name === "AbortError") return;
      console.error("[scribe] share failed", error);
      setStatus("Could not open the share sheet");
    }
  });

  refresh();
  return { refresh };
}
```

- [ ] **Step 4: Wire the markup**

In `src/web/index.html`, replace the summary section's heading line so the three
controls sit in the pane header:

```html
      <section class="pane" aria-labelledby="summary-heading">
        <div class="pane__head">
          <h2 id="summary-heading">Summary</h2>
          <div class="pane__actions" id="summary-actions">
            <button id="summary-copy" class="ghost" type="button">Copy</button>
            <button id="summary-save" class="ghost" type="button">Save</button>
            <button id="summary-share" class="ghost" type="button" hidden>Share</button>
          </div>
        </div>
        <div id="summary" class="summary">
          <p class="empty">The first summary appears after about five minutes.</p>
        </div>
      </section>
```

Append to `src/web/styles.css`:

```css
/* ── Pane header: title left, export controls right. Flat ghost buttons —
      they are secondary to the record button, which keeps the one accent. ── */
.pane__head{
  display:flex; align-items:center; justify-content:space-between;
  gap:var(--s3); margin-bottom:var(--s3);
}
.pane__actions{ display:flex; gap:var(--s2); }

.ghost{
  font:500 var(--t-cap)/var(--lh-flat) var(--font);
  letter-spacing:var(--tr-cap);
  padding:8px 16px;
  border:1px solid var(--line);
  border-radius:var(--r-sm);
  background:var(--surface-1);
  color:var(--ink-2);
  white-space:nowrap;
  cursor:pointer;
}
.ghost:hover:not(:disabled){ background:var(--surface-2); color:var(--ink); }
.ghost:active:not(:disabled){ background:var(--surface-3); }
.ghost:disabled{ opacity:.45; cursor:default; }
```

In `src/web/app.js`, import the factory and hold the summary that is on screen:

```js
import { createExportControls } from "./summary-export.js";

// What the export controls act on: whichever summary is displayed right now.
let displayedSummary = null; // { kind: "running", summary } | { kind: "markdown", markdown }
let displayedTitle = "Summary";
let recording = false;

const exportControls = createExportControls({
  root: document.getElementById("summary-actions"),
  getSummary: () => ({
    input: displayedSummary,
    title: displayedTitle,
    sessionId,
    recording,
  }),
  setStatus,
});
```

Set `displayedSummary = { kind: "running", summary }` in `renderSummary`, set
`displayedSummary = { kind: "markdown", markdown }` where `stop()` renders the
final summary, set `recording` true in `start()` and false in `stop()`, and call
`exportControls.refresh()` after each. Set `displayedTitle` to
`` `Scribe ${new Date().toLocaleDateString()}` `` for a live session; Task 14
replaces it with the real session title when a past session is opened.

- [ ] **Step 5: Verify by hand**

Run `npm start`, record for long enough to get one running summary, then press
Copy and paste into a chat window: it should read as plain prose with `•`
bullets and no `##` or `**`. Press Save and confirm the `.md` lands in Downloads
with the expected name. If Share is visible, press it and cancel — the status
line must stay quiet. Clipboard, download, and share wiring is verified by hand,
as with the capture pipeline: no usable test double exists and mocking it would
test the mock.

- [ ] **Step 6: Run tests, typecheck, and commit**

```bash
npm test && npm run typecheck
git add src/web/summary-export.js src/web/app.js src/web/index.html src/web/styles.css tests/summary-export.test.js
git commit -m "feat: copy, save, and share the summary on screen"
```

---

### Task 13: The insertion-index calculation

**Files:**
- Create: `src/web/dnd.js`
- Test: `tests/dnd.test.js`

**Why its own function:** this is where off-by-one errors live, and it is the
part a test can actually pin. Direct lesson from the resampler defect in the
previous build, where the logic was correct in isolation but wrong in the call
pattern the tests never exercised.

**Interfaces:**
- Consumes: nothing.
- Produces: `function insertionIndex(pointerY, rects)` where `rects` is an array of `{ top, bottom }` in visual order; returns an integer in `[0, rects.length]`.

- [ ] **Step 1: Write the failing test**

Create `tests/dnd.test.js`:

```js
import { describe, it, expect } from "vitest";
import { insertionIndex } from "../src/web/dnd.js";

// Three 40px rows starting at y=100, as a real sidebar would report them.
const rows = [
  { top: 100, bottom: 140 },
  { top: 140, bottom: 180 },
  { top: 180, bottom: 220 },
];

describe("insertionIndex", () => {
  it("returns 0 for an empty category", () => {
    expect(insertionIndex(150, [])).toBe(0);
  });

  it("drops above the first row into the first slot", () => {
    expect(insertionIndex(100, rows)).toBe(0);
    expect(insertionIndex(119, rows)).toBe(0);
  });

  it("drops below a row's midpoint into the slot after it", () => {
    expect(insertionIndex(121, rows)).toBe(1);
    expect(insertionIndex(161, rows)).toBe(2);
  });

  it("drops below the last row into the last slot", () => {
    expect(insertionIndex(219, rows)).toBe(3);
    expect(insertionIndex(9999, rows)).toBe(3);
  });

  it("puts a pointer exactly on a midpoint into the slot after that row", () => {
    expect(insertionIndex(120, rows)).toBe(1);
  });

  it("clamps a pointer above the list to the first slot", () => {
    expect(insertionIndex(-50, rows)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dnd.test.js`
Expected: FAIL — cannot resolve `../src/web/dnd.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/dnd.js`:

```js
/**
 * Which slot a drop lands in, given the pointer's y position and the row
 * rectangles in visual order. A row counts as passed once the pointer is at
 * or below its midpoint, so the insertion line sits where the eye expects.
 */
export function insertionIndex(pointerY, rects) {
  let index = 0;
  for (const rect of rects) {
    if (pointerY < (rect.top + rect.bottom) / 2) break;
    index += 1;
  }
  return index;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/dnd.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/dnd.js tests/dnd.test.js
git commit -m "feat: insertion-index calculation for the history drag"
```

---

### Task 14: The sidebar — rendering, opening, renaming

**Files:**
- Create: `src/web/history.js`
- Modify: `src/web/app.js`
- Modify: `src/web/index.html`
- Modify: `src/web/styles.css` (append)

**Interfaces:**
- Consumes: `GET /api/library`, `GET /api/sessions/:id`, `PATCH /api/sessions/:id` (Tasks 7–8).
- Produces: `function createHistory({ root, toggle, setStatus, canOpen, onOpen, onLive })` returning `{ refresh(), close() }`.
  - `canOpen()` returns `true` when a past session may be opened. **This is the only place the recording restriction lives.** Lifting it later is this one function plus the overlay UI.
  - `onOpen(session)` receives the `GET /api/sessions/:id` payload.
  - `onLive()` returns the panes to the live recording.

**View mode, required by the spec:** the panes render from an explicit view mode
and a passed source object, never from module state read directly. Adding a
third mode later must be an addition, not a restructuring.

- [ ] **Step 1: Restructure the panes in `app.js` around an explicit view**

```js
// Either "live" or `session:<id>`. The panes take their data from the source
// passed to render(), never from module state, so a third mode later is an
// addition rather than a restructuring.
let viewMode = "live";

const liveSource = { lines: [], summary: null, title: null };

function renderTranscript(lines) {
  transcriptEl.replaceChildren();
  for (const line of lines) appendLine(line);
}

function render(mode, source) {
  viewMode = mode;
  renderTranscript(source.lines);

  if (source.summary?.kind === "running") renderSummary(source.summary.summary);
  else if (source.summary?.kind === "markdown") renderFinal(source.summary.markdown);
  else renderEmptySummary();

  displayedSummary = source.summary;
  displayedTitle = source.title ?? "Summary";
  document.body.dataset.view = mode;
  exportControls.refresh();
}
```

`appendLine` keeps appending to the live source: in the SSE handler push the
line into `liveSource.lines` first, and only touch the DOM when
`viewMode === "live"`. Same for `summary` and `final` events — always update
`liveSource`, render only in live mode. That way a recording that continued
while a past session was open is intact when the user returns to it.

`renderFinal(markdown)` is the existing `<pre class="final">` path lifted out of
`stop()`; `renderEmptySummary()` restores the `<p class="empty">` placeholder.

- [ ] **Step 2: Write the sidebar module**

Create `src/web/history.js`:

```js
function formatDuration(seconds) {
  if (seconds == null) return "";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function createHistory({ root, toggle, setStatus, canOpen, onOpen, onLive }) {
  const listEl = root.querySelector("#history-list");
  const restoreButton = root.querySelector("#history-restore");
  let library = { categories: [], canRestore: false };
  let openId = null;

  // Remembered so the drawer is where the user left it across reloads.
  const OPEN_KEY = "scribe.sidebar.open";
  const setOpen = (open) => {
    document.body.dataset.sidebar = open ? "open" : "closed";
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  };
  setOpen(localStorage.getItem(OPEN_KEY) !== "0");
  toggle.addEventListener("click", () => {
    setOpen(document.body.dataset.sidebar !== "open");
  });

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error ?? `${method} ${url} failed`);
    return payload;
  }

  async function refresh() {
    library = await api("GET", "/api/library");
    paint();
  }

  function paint() {
    listEl.replaceChildren();
    for (const category of library.categories) {
      listEl.append(renderCategory(category));
    }
    restoreButton.hidden = !library.canRestore;
    restoreButton.dataset.armed = "no";
    restoreButton.textContent = "Restore library to when Scribe opened";
  }

  function renderCategory(category) {
    const section = document.createElement("section");
    section.className = "cat";
    section.dataset.categoryId = category.id;

    const heading = document.createElement("h3");
    heading.className = "cat__name";
    heading.textContent = category.name;
    if (category.id !== "uncategorised") {
      heading.addEventListener("dblclick", () => editInline(heading, category.name, (name) =>
        api("PATCH", `/api/categories/${category.id}`, { name }).then(applyPayload),
      ));
    }

    const rows = document.createElement("div");
    rows.className = "cat__rows";
    for (const session of category.sessions) rows.append(renderRow(session));

    section.append(heading, rows);
    return section;
  }

  function renderRow(session) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row";
    row.dataset.sessionId = session.id;
    if (session.id === openId) row.dataset.open = "yes";
    if (session.live) row.dataset.live = "yes";

    const name = document.createElement("span");
    name.className = "row__name";
    name.textContent = session.title;

    const meta = document.createElement("span");
    meta.className = "row__meta";
    meta.textContent = session.live ? "Recording" : formatDuration(session.audioSeconds);

    row.append(name, meta);
    row.addEventListener("click", () => open(session));
    row.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      editInline(name, session.named ? session.title : "", (title) =>
        api("PATCH", `/api/sessions/${session.id}`, { title }).then(applyPayload),
      );
    });
    return row;
  }

  function applyPayload(payload) {
    library = payload;
    paint();
  }

  /**
   * The whole recording restriction. Lifting it later is this function plus
   * the overlay UI, not a hunt through the view logic.
   */
  async function open(session) {
    if (!canOpen()) {
      setStatus("Stop recording to read past sessions");
      return;
    }
    if (session.live) {
      openId = null;
      onLive();
      paint();
      return;
    }
    try {
      const payload = await api("GET", `/api/sessions/${session.id}`);
      openId = session.id;
      onOpen(payload);
      paint();
    } catch (error) {
      setStatus(`Could not open that session: ${error.message}`);
    }
  }

  /** One interaction for both rows and headings, rather than two to learn. */
  function editInline(labelEl, current, commit) {
    const input = document.createElement("input");
    input.className = "inline-edit";
    input.value = current;
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = async (save) => {
      if (settled) return;
      settled = true;
      const value = input.value;
      input.replaceWith(labelEl);
      if (!save) return;
      try {
        await commit(value);
      } catch (error) {
        // Optimism rolled back: the reason goes where every other reason goes.
        setStatus(`Could not save that name: ${error.message}`);
        await refresh().catch(() => {});
      }
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  restoreButton.addEventListener("click", async () => {
    // Two-step inline confirm. A native confirm() blocks the page and is out
    // of keeping with how the rest of this app reports things.
    if (restoreButton.dataset.armed !== "yes") {
      restoreButton.dataset.armed = "yes";
      restoreButton.textContent = "Click again to restore";
      return;
    }
    try {
      applyPayload(await api("POST", "/api/library/restore"));
      setStatus("Library restored to when Scribe opened");
    } catch (error) {
      setStatus(`Could not restore: ${error.message}`);
      paint();
    }
  });

  return { refresh, api, applyPayload, get library() { return library; } };
}
```

- [ ] **Step 3: Wire it into `app.js` and the markup**

Add the hamburger and drawer to `src/web/index.html` — the button first in
`.bar`, the aside before `<main>`:

```html
      <button id="sidebar-toggle" class="hamburger" type="button" aria-label="Sessions">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
```

```html
    <aside id="history" class="drawer" aria-label="Sessions">
      <div id="history-list" class="drawer__list"></div>
      <footer class="drawer__foot">
        <button id="history-restore" class="ghost" type="button" hidden>
          Restore library to when Scribe opened
        </button>
      </footer>
    </aside>
    <div id="scrim" class="scrim"></div>
```

In `src/web/app.js`:

```js
import { createHistory } from "./history.js";

const history = createHistory({
  root: document.getElementById("history"),
  toggle: document.getElementById("sidebar-toggle"),
  setStatus,
  canOpen: () => !recording,
  onOpen: (session) => {
    render(`session:${session.id}`, {
      lines: parseTranscript(session.transcript),
      summary: session.summaryMarkdown
        ? { kind: "markdown", markdown: session.summaryMarkdown }
        : session.runningSummary
          ? { kind: "running", summary: session.runningSummary }
          : null,
      title: session.title,
    });
    setStatus(`Reading ${session.title}`);
  },
  onLive: () => render("live", liveSource),
});

history.refresh().catch((error) => setStatus(`Could not load the library: ${error.message}`));
document.getElementById("scrim").addEventListener("click", () => {
  document.body.dataset.sidebar = "closed";
});
```

`parseTranscript(markdown)` turns a saved transcript back into the shape
`appendLine` expects. `Transcript.toMarkdown()` writes `[MM:SS] text` blocks
separated by a blank line, and a dropped chunk's text is `[inaudible ~MM:SS]`,
so:

```js
/** The inverse of Transcript.toMarkdown(): "[MM:SS] text", blank-line separated. */
function parseTranscript(markdown) {
  const lines = [];
  for (const block of String(markdown ?? "").split("\n")) {
    const match = /^\[(\d{2}):(\d{2})\]\s(.*)$/.exec(block);
    if (!match) continue;
    const startMs = (Number(match[1]) * 60 + Number(match[2])) * 1000;
    lines.push({
      index: lines.length,
      startMs,
      endMs: startMs,
      text: match[3],
      failed: match[3].startsWith("[inaudible"),
    });
  }
  return lines;
}
```

Call `history.refresh()` again after `stop()` resolves so the finished session
picks up its duration and drops its live marker.

- [ ] **Step 4: Style the drawer**

Append to `src/web/styles.css`:

```css
/* ── Sessions drawer. Inline on a wide window, overlaid below 900px so the
      transcript is never squeezed into an unreadable column. ── */
.hamburger{
  display:grid; place-items:center;
  width:36px; height:36px;
  border:1px solid var(--line); border-radius:var(--r-sm);
  background:var(--surface-1); color:var(--ink-2); cursor:pointer;
}
.hamburger:hover{ background:var(--surface-2); color:var(--ink); }

.drawer{
  display:none;
  flex-direction:column; justify-content:space-between;
  width:264px; padding:var(--s4);
  background:var(--surface-1);
  border-right:1px solid var(--line);
  overflow-y:auto;
}
body[data-sidebar="open"] .drawer{ display:flex; }

.drawer__list{ display:flex; flex-direction:column; gap:var(--s5); }
.drawer__foot{ padding-top:var(--s4); }

.cat__name{
  font:600 var(--t-cap)/var(--lh-tight) var(--font);
  letter-spacing:var(--tr-eyebrow); text-transform:uppercase;
  color:var(--ink-2); margin:0 0 var(--s2);
}
.cat__rows{ display:flex; flex-direction:column; gap:2px; }

.row{
  display:flex; align-items:baseline; justify-content:space-between; gap:var(--s2);
  width:100%; padding:8px var(--s3); text-align:left;
  border:0; border-radius:var(--r-sm);
  background:transparent; color:var(--ink); cursor:pointer;
}
.row:hover{ background:var(--surface-2); }
.row[data-open="yes"]{ background:var(--surface-3); }
.row__name{
  font:500 var(--t-cap)/var(--lh-tight) var(--font);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.row__meta{ font:400 calc(var(--fs-base)*.72)/var(--lh-flat) var(--font); color:var(--ink-3); }
.row[data-live="yes"] .row__meta{ color:var(--ink-2); }

.inline-edit{
  width:100%; padding:6px var(--s2);
  font:500 var(--t-cap)/var(--lh-tight) var(--font);
  border:1px solid var(--line); border-radius:var(--r-sm);
  background:var(--surface-1); color:var(--ink);
}

.scrim{ display:none; }

@media (max-width: 900px){
  .drawer{
    position:fixed; inset:0 auto 0 0; z-index:var(--z-overlay);
    box-shadow:var(--shadow-pop);
  }
  body[data-sidebar="open"] .scrim{
    display:block; position:fixed; inset:0;
    z-index:calc(var(--z-overlay) - 1);
    background:rgba(18,18,18,.28);
  }
}
```

`body` is already `display:grid; grid-template-rows:auto 1fr`. Extend that same
grid rather than introducing a second layout system — a second column that
collapses to nothing when the drawer is hidden, with the bar spanning both:

```css
/* One grid, two columns. A closed drawer is display:none, so the auto track
   collapses to zero and the panes get the whole width back. */
body{ grid-template-columns:auto 1fr; }
.bar{ grid-column:1 / -1; }
```

- [ ] **Step 5: Verify by hand**

Run `npm start` with at least two session folders present. Check: the drawer
opens and closes from the hamburger and survives a reload; a session opens into
the two panes read-only; double-clicking a title renames it and a reload keeps
the name; clearing a name reverts it to the date; the restore control asks for a
second click; clicking a row while recording shows "Stop recording to read past
sessions" and does not swap the panes; narrowing the window below 900px overlays
the drawer with a scrim.

- [ ] **Step 6: Run tests, typecheck, and commit**

```bash
npm test && npm run typecheck
git add src/web/history.js src/web/app.js src/web/index.html src/web/styles.css
git commit -m "feat: sessions sidebar with reading, renaming, and library restore"
```

---

### Task 15: Dragging sessions, and the row context menu

**Files:**
- Modify: `src/web/dnd.js`
- Modify: `src/web/history.js`
- Modify: `src/web/styles.css` (append)

**Interfaces:**
- Consumes: `insertionIndex` (Task 13), the `api`/`applyPayload` helpers returned by `createHistory` (Task 14), `PUT /api/library/order`, `POST /api/categories`, `DELETE /api/categories/:id`, `POST /api/sessions/:id/reveal`.
- Produces: `function attachDragAndDrop({ listEl, onDrop })` in `dnd.js`, where `onDrop({ sessionId, categoryId, index })` fires once a drag completes; and a context menu in `history.js`.

- [ ] **Step 1: Write the drag wiring**

Append to `src/web/dnd.js`:

```js
/**
 * Native HTML5 drag events rather than pointer events: the drag image comes
 * free, the list is short, and this is a trackpad-driven desktop tool, so the
 * touch support pointer events would buy has no user here.
 */
export function attachDragAndDrop({ listEl, onDrop }) {
  let draggingId = null;
  // dragleave fires when the cursor crosses a child element, so depth is
  // counted per zone rather than trusted per event.
  const depths = new WeakMap();

  listEl.addEventListener("dragstart", (event) => {
    const row = event.target.closest(".row");
    if (!row) return;
    draggingId = row.dataset.sessionId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggingId);
    row.dataset.dragging = "yes";
  });

  listEl.addEventListener("dragend", (event) => {
    const row = event.target.closest(".row");
    if (row) delete row.dataset.dragging;
    draggingId = null;
    clearMarkers();
  });

  function clearMarkers() {
    for (const el of listEl.querySelectorAll("[data-drop]")) delete el.dataset.drop;
    for (const el of listEl.querySelectorAll(".insert")) el.remove();
  }

  function zoneFor(event) {
    return event.target.closest(".cat");
  }

  listEl.addEventListener("dragenter", (event) => {
    const zone = zoneFor(event);
    if (!zone || !draggingId) return;
    depths.set(zone, (depths.get(zone) ?? 0) + 1);
    zone.dataset.drop = "yes";
  });

  listEl.addEventListener("dragleave", (event) => {
    const zone = zoneFor(event);
    if (!zone) return;
    const depth = (depths.get(zone) ?? 0) - 1;
    depths.set(zone, depth);
    if (depth <= 0) delete zone.dataset.drop;
  });

  listEl.addEventListener("dragover", (event) => {
    const zone = zoneFor(event);
    if (!zone || !draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const rows = [...zone.querySelectorAll(".row")];
    const index = insertionIndex(
      event.clientY,
      rows.map((row) => row.getBoundingClientRect()),
    );

    for (const el of zone.querySelectorAll(".insert")) el.remove();
    const line = document.createElement("div");
    line.className = "insert";
    const rowsEl = zone.querySelector(".cat__rows");
    rowsEl.insertBefore(line, rows[index] ?? null);
  });

  listEl.addEventListener("drop", (event) => {
    const zone = zoneFor(event);
    if (!zone || !draggingId) return;
    event.preventDefault();

    const rows = [...zone.querySelectorAll(".row")].filter(
      (row) => row.dataset.sessionId !== draggingId,
    );
    const index = insertionIndex(
      event.clientY,
      rows.map((row) => row.getBoundingClientRect()),
    );
    const sessionId = draggingId;
    const categoryId = zone.dataset.categoryId;
    clearMarkers();
    draggingId = null;

    onDrop({ sessionId, categoryId: categoryId === "uncategorised" ? null : categoryId, index });
  });
}
```

- [ ] **Step 2: Build the payload and the menu in `history.js`**

In `renderRow`, set `row.draggable = true`.

Add to `createHistory`, after `paint` is defined:

```js
import { attachDragAndDrop } from "./dnd.js";

  /** One drag renumbers rows across two categories, so it goes as one payload
   *  and the library cannot be left half-applied. */
  function orderPayload({ sessionId, categoryId, index }) {
    const groups = library.categories.map((category) => ({
      categoryId: category.id === "uncategorised" ? null : category.id,
      sessionIds: category.sessions.map((s) => s.id).filter((id) => id !== sessionId),
    }));

    let target = groups.find((g) => g.categoryId === categoryId);
    if (!target) {
      target = { categoryId, sessionIds: [] };
      groups.push(target);
    }
    target.sessionIds.splice(index, 0, sessionId);
    return { groups };
  }

  attachDragAndDrop({
    listEl,
    onDrop: async (drop) => {
      try {
        applyPayload(await api("PUT", "/api/library/order", orderPayload(drop)));
      } catch (error) {
        setStatus(`Could not move that session: ${error.message}`);
        await refresh().catch(() => {});
      }
    },
  });
```

Add the context menu — Rename, Move to category, Reveal in Finder — and the
"New category" control in the drawer footer:

```js
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.hidden = true;
  document.body.append(menu);
  document.addEventListener("click", () => { menu.hidden = true; });

  function openMenu(event, session, nameEl) {
    event.preventDefault();
    menu.replaceChildren();
    menu.hidden = false;
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    const item = (label, action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu__item";
      button.textContent = label;
      button.addEventListener("click", action);
      menu.append(button);
    };

    item("Rename", () =>
      editInline(nameEl, session.named ? session.title : "", (title) =>
        api("PATCH", `/api/sessions/${session.id}`, { title }).then(applyPayload),
      ),
    );

    for (const category of library.categories) {
      if (category.id === "uncategorised") continue;
      item(`Move to ${category.name}`, async () => {
        try {
          applyPayload(
            await api("PATCH", `/api/sessions/${session.id}`, { categoryId: category.id }),
          );
        } catch (error) {
          setStatus(`Could not move that session: ${error.message}`);
        }
      });
    }

    item("Reveal in Finder", async () => {
      try {
        await api("POST", `/api/sessions/${session.id}/reveal`);
      } catch (error) {
        setStatus(`Could not open the folder: ${error.message}`);
      }
    });
  }
```

Bind it in `renderRow` with `row.addEventListener("contextmenu", (event) => openMenu(event, session, name));`.

Add a "New category" button beside the restore control in `index.html`:

```html
        <button id="history-new-category" class="ghost" type="button">New category</button>
```

```js
  root.querySelector("#history-new-category").addEventListener("click", async () => {
    try {
      const payload = await api("POST", "/api/categories", { name: "New category" });
      applyPayload(payload);
      // Straight into a rename: a heading called "New category" is not a name.
      const heading = listEl.querySelector(".cat:last-of-type .cat__name");
      if (heading) {
        const id = heading.closest(".cat").dataset.categoryId;
        editInline(heading, "", (name) =>
          api("PATCH", `/api/categories/${id}`, { name }).then(applyPayload),
        );
      }
    } catch (error) {
      setStatus(`Could not add a category: ${error.message}`);
    }
  });
```

Add a Delete option to the heading's own context menu, mirroring the row menu:
right-clicking a `.cat__name` offers Rename and Delete, where Delete calls
`api("DELETE", `/api/categories/${id}`)` and reports failures the same way.
Deleting never touches recordings — its sessions fall back to Uncategorised.

- [ ] **Step 3: Style the drop line and the menu**

Append to `src/web/styles.css`:

```css
.row[data-dragging="yes"]{ opacity:.4; }
.cat[data-drop="yes"]{ background:var(--surface-2); border-radius:var(--r-sm); }

.insert{ height:2px; margin:1px 0; background:var(--accent); border-radius:1px; }

.menu{
  position:fixed; z-index:var(--z-overlay);
  min-width:180px; padding:var(--s1);
  display:flex; flex-direction:column;
  background:var(--surface-1);
  border:1px solid var(--line); border-radius:var(--r-md);
  box-shadow:var(--shadow-pop);
}
.menu__item{
  padding:8px var(--s3); text-align:left;
  font:400 var(--t-cap)/var(--lh-tight) var(--font);
  border:0; border-radius:var(--r-sm);
  background:transparent; color:var(--ink);
  white-space:nowrap; cursor:pointer;
}
.menu__item:hover{ background:var(--surface-2); }
```

- [ ] **Step 4: Verify by hand**

Run `npm start`. Drag a session between two categories and reload: the position
holds. Drag to the top slot, the bottom slot, and into an empty category. Drag
across a child element and confirm the drop zone highlight does not flicker off.
Right-click a row for Rename, Move, and Reveal in Finder, and confirm Reveal
opens the right folder. Delete a category and confirm its sessions reappear
under Uncategorised with their titles intact and their folders untouched.

- [ ] **Step 5: Run tests, typecheck, and commit**

```bash
npm test && npm run typecheck
git add src/web/dnd.js src/web/history.js src/web/index.html src/web/styles.css
git commit -m "feat: drag sessions between categories and a row context menu"
```

---

## Verification before calling this done

- [ ] `npm test` — full suite green, no skips beyond the two live API tests.
- [ ] `npm run typecheck` — clean.
- [ ] The hand-verification steps in Tasks 12, 14, and 15 all done against a
      running server with real session folders, not just unit tests.
- [ ] `sessions/library.json` survives a kill -9 mid-write: no `.tmp` file left,
      previous content intact.
- [ ] A restore after a restart returns the library to its state at start, and
      `sessions/.library-backups/archive/` holds the state it replaced.
