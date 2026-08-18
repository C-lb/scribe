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

  describe("mergeLibrary", () => {
    it("mixes ordered and unordered rows in a bucket: ordered first by order, unordered last", () => {
      // A category holding two sessions with explicit order (0, 1) and one without.
      // The ordered ones should come first in their order, and the unordered one last.
      const view = mergeLibrary(
        {
          version: 1,
          categories: [{ id: "cat_a", name: "BUSI 520", order: 0 }],
          entries: {
            "2026-08-18-17-03-30": { categoryId: "cat_a", order: 0 },
            "2026-08-17-17-03-30": { categoryId: "cat_a", order: 1 },
            "2026-08-16-17-03-30": { categoryId: "cat_a" }, // no order
          },
        },
        [
          folder("2026-08-18-17-03-30"),
          folder("2026-08-17-17-03-30"),
          folder("2026-08-16-17-03-30"),
        ],
        null,
      );
      expect(view.categories[0].sessions.map((s) => s.id)).toEqual([
        "2026-08-18-17-03-30",
        "2026-08-17-17-03-30",
        "2026-08-16-17-03-30",
      ]);
    });
  });
});

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
