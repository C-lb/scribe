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
