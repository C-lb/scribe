import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildNote, demoteHeadings, noteFilename, exportSession, UNCATEGORISED_FOLDER } from "../src/server/obsidian.js";
import type { LibraryFile } from "../src/server/library.js";

const ID = "2026-08-25-12-04-38";

async function scratch() {
  const root = await mkdtemp(path.join(tmpdir(), "scribe-obsidian-"));
  const sessionsDir = path.join(root, "sessions");
  const obsidianDir = path.join(root, "vault", "Resources", "Scribe");
  await mkdir(sessionsDir, { recursive: true });
  return { sessionsDir, obsidianDir };
}

async function seedSession(
  sessionsDir: string,
  id = ID,
  files: { transcript?: string; summary?: string; meta?: unknown } = {},
) {
  const dir = path.join(sessionsDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "transcript.md"), files.transcript ?? "[00:00] Hello.\n", "utf8");
  if (files.summary !== undefined) {
    await writeFile(path.join(dir, "summary.md"), files.summary, "utf8");
  }
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify(files.meta ?? { id, audioSeconds: 214 }),
    "utf8",
  );
}

async function seedLibrary(sessionsDir: string, file: LibraryFile) {
  await writeFile(path.join(sessionsDir, "library.json"), JSON.stringify(file), "utf8");
}

function library(categoryName: string | null, title?: string): LibraryFile {
  return {
    version: 1,
    categories: categoryName ? [{ id: "c1", name: categoryName, order: 0 }] : [],
    entries: {
      [ID]: {
        ...(categoryName ? { categoryId: "c1" } : {}),
        ...(title ? { title } : {}),
      },
    },
  };
}

async function listNotes(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) found.push(entry.name);
    if (!entry.isDirectory()) continue;
    for (const child of await readdir(path.join(root, entry.name))) {
      if (child.endsWith(".md")) found.push(`${entry.name}/${child}`);
    }
  }
  return found.sort();
}

describe("noteFilename", () => {
  it("replaces the characters Obsidian and the filesystem both refuse", () => {
    expect(noteFilename("25 August 2026, 12:04", ID)).toBe("25 August 2026, 12-04");
    expect(noteFilename("BUSI 520 / week 3", ID)).toBe("BUSI 520 - week 3");
    expect(noteFilename("Notes [draft] #2", ID)).toBe("Notes -draft- -2");
  });

  it("keeps the letters a lecture title actually uses", () => {
    expect(noteFilename("Café économétrie", ID)).toBe("Café économétrie");
  });

  it("never produces a hidden, empty or trailing-dot name", () => {
    expect(noteFilename(".hidden", ID)).toBe("hidden");
    expect(noteFilename("trailing.", ID)).toBe("trailing");
    expect(noteFilename("///", ID)).toBe(ID);
    expect(noteFilename("   ", ID)).toBe(ID);
  });
});

describe("demoteHeadings", () => {
  it("pushes the summary's own headings under the note's", () => {
    expect(demoteHeadings("# Lecture\n## Part one\ntext\n")).toBe("### Lecture\n#### Part one\ntext\n");
  });

  it("stops at six, and leaves fenced code alone", () => {
    expect(demoteHeadings("##### deep")).toBe("###### deep");
    expect(demoteHeadings("```sh\n# not a heading\n```\n# heading")).toBe(
      "```sh\n# not a heading\n```\n### heading",
    );
  });
});

describe("buildNote", () => {
  it("writes frontmatter, the summary and the transcript", () => {
    const note = buildNote({
      id: ID,
      title: "25 August 2026, 12:04",
      categoryName: "BUSI 520",
      summaryMarkdown: "## Topics\n- Discounting\n",
      transcript: "[00:00] Hello.\n",
      audioSeconds: 214,
    });
    expect(note).toContain(`scribe_id: "${ID}"`);
    expect(note).toContain('category: "BUSI 520"');
    expect(note).toContain('date: "2026-08-25 12:04"');
    expect(note).toContain('duration: "3m 34s"');
    expect(note).toContain("tags: [scribe]");
    expect(note).toContain("## Summary");
    expect(note).toContain("## Transcript");
    expect(note.indexOf("## Summary")).toBeLessThan(note.indexOf("## Transcript"));
  });

  it("quotes a title holding a colon so the frontmatter stays parseable", () => {
    const note = buildNote({
      id: ID,
      title: 'Lecture 3: "risk", revisited',
      categoryName: null,
      summaryMarkdown: null,
      transcript: "x",
    });
    expect(note).toContain('title: "Lecture 3: \\"risk\\", revisited"');
    expect(note).toContain(`category: "${UNCATEGORISED_FOLDER}"`);
  });

  it("leaves out the summary heading when there is no summary", () => {
    const note = buildNote({
      id: ID,
      title: "t",
      categoryName: null,
      summaryMarkdown: "   ",
      transcript: "x",
    });
    expect(note).not.toContain("## Summary");
    expect(note).toContain("## Transcript");
  });
});

describe("exportSession", () => {
  it("does nothing at all when no vault is configured", async () => {
    const { sessionsDir } = await scratch();
    await seedSession(sessionsDir);
    expect(await exportSession({ sessionsDir, obsidianDir: null, id: ID })).toBeNull();
  });

  it("writes the note under the category folder", async () => {
    const { sessionsDir, obsidianDir } = await scratch();
    await seedSession(sessionsDir, ID, { summary: "# Notes\n" });
    await seedLibrary(sessionsDir, library("BUSI 520", "Week 3: cash flows"));

    const result = await exportSession({ sessionsDir, obsidianDir, id: ID });

    expect(result?.path).toBe(path.join(obsidianDir, "BUSI 520", "Week 3- cash flows.md"));
    const note = await readFile(result!.path, "utf8");
    expect(note).toContain("# Notes");
    expect(note).toContain("[00:00] Hello.");
  });

  it("files an uncategorised session under Uncategorised, named by its date", async () => {
    const { sessionsDir, obsidianDir } = await scratch();
    await seedSession(sessionsDir);
    await seedLibrary(sessionsDir, library(null));

    const result = await exportSession({ sessionsDir, obsidianDir, id: ID });

    expect(result?.path).toBe(
      path.join(obsidianDir, UNCATEGORISED_FOLDER, "25 August 2026, 12-04.md"),
    );
  });

  it("moves the note instead of duplicating it when the title changes", async () => {
    const { sessionsDir, obsidianDir } = await scratch();
    await seedSession(sessionsDir);
    await seedLibrary(sessionsDir, library("BUSI 520", "First name"));
    await exportSession({ sessionsDir, obsidianDir, id: ID });

    await seedLibrary(sessionsDir, library("BUSI 520", "Second name"));
    await exportSession({ sessionsDir, obsidianDir, id: ID });

    expect(await listNotes(obsidianDir)).toEqual(["BUSI 520/Second name.md"]);
  });

  it("moves the note between folders when the session is refiled", async () => {
    const { sessionsDir, obsidianDir } = await scratch();
    await seedSession(sessionsDir);
    await seedLibrary(sessionsDir, library("BUSI 520", "Week 3"));
    await exportSession({ sessionsDir, obsidianDir, id: ID });

    await seedLibrary(sessionsDir, library("BUSI 505", "Week 3"));
    await exportSession({ sessionsDir, obsidianDir, id: ID });

    expect(await listNotes(obsidianDir)).toEqual(["BUSI 505/Week 3.md"]);
  });

  it("leaves other sessions' notes alone while moving its own", async () => {
    const { sessionsDir, obsidianDir } = await scratch();
    const other = "2026-08-22-18-13-20";
    await seedSession(sessionsDir);
    await seedSession(sessionsDir, other);
    await seedLibrary(sessionsDir, {
      version: 1,
      categories: [{ id: "c1", name: "BUSI 520", order: 0 }],
      entries: {
        [ID]: { categoryId: "c1", title: "Mine" },
        [other]: { categoryId: "c1", title: "Theirs" },
      },
    });
    await exportSession({ sessionsDir, obsidianDir, id: ID });
    await exportSession({ sessionsDir, obsidianDir, id: other });

    await seedLibrary(sessionsDir, {
      version: 1,
      categories: [{ id: "c1", name: "BUSI 520", order: 0 }],
      entries: {
        [ID]: { categoryId: "c1", title: "Renamed" },
        [other]: { categoryId: "c1", title: "Theirs" },
      },
    });
    await exportSession({ sessionsDir, obsidianDir, id: ID });

    expect(await listNotes(obsidianDir)).toEqual(["BUSI 520/Renamed.md", "BUSI 520/Theirs.md"]);
  });

  it("re-exporting an unchanged session rewrites the same one file", async () => {
    const { sessionsDir, obsidianDir } = await scratch();
    await seedSession(sessionsDir);
    await seedLibrary(sessionsDir, library("BUSI 520", "Week 3"));
    const first = await exportSession({ sessionsDir, obsidianDir, id: ID });
    const second = await exportSession({ sessionsDir, obsidianDir, id: ID });

    expect(second?.path).toBe(first?.path);
    expect(await listNotes(obsidianDir)).toEqual(["BUSI 520/Week 3.md"]);
  });

  it("leaves notes the user wrote themselves alone", async () => {
    const { sessionsDir, obsidianDir } = await scratch();
    await mkdir(path.join(obsidianDir, "BUSI 520"), { recursive: true });
    await writeFile(path.join(obsidianDir, "BUSI 520", "My own note.md"), "mine\n", "utf8");
    await seedSession(sessionsDir);
    await seedLibrary(sessionsDir, library("BUSI 520", "Week 3"));

    await exportSession({ sessionsDir, obsidianDir, id: ID });

    expect(await listNotes(obsidianDir)).toEqual([
      "BUSI 520/My own note.md",
      "BUSI 520/Week 3.md",
    ]);
  });

  it("refuses a session id that is not one", async () => {
    const { sessionsDir, obsidianDir } = await scratch();
    await expect(
      exportSession({ sessionsDir, obsidianDir, id: "../../etc" }),
    ).rejects.toThrow(/invalid session id/);
  });

  it("refuses a session with neither a transcript nor a summary", async () => {
    const { sessionsDir, obsidianDir } = await scratch();
    await mkdir(path.join(sessionsDir, ID), { recursive: true });
    await expect(exportSession({ sessionsDir, obsidianDir, id: ID })).rejects.toThrow(
      /nothing to export/,
    );
  });

  it("leaves no temp file behind", async () => {
    const { sessionsDir, obsidianDir } = await scratch();
    await seedSession(sessionsDir);
    await seedLibrary(sessionsDir, library("BUSI 520", "Week 3"));
    await exportSession({ sessionsDir, obsidianDir, id: ID });

    const names = await readdir(path.join(obsidianDir, "BUSI 520"));
    expect(names).toEqual(["Week 3.md"]);
  });
});
