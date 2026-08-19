import { describe, it, expect } from "vitest";
import { categoryOrderPayload, insertionIndex, orderPayload } from "../src/web/dnd.js";

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

// Two named categories and the Uncategorised bucket, as GET /api/library
// returns them. Only the ids matter here.
const sessions = (...ids) => ids.map((id) => ({ id }));
const library = () => [
  { id: "cat_lectures", name: "Lectures", sessions: sessions("a", "b", "c") },
  { id: "cat_seminars", name: "Seminars", sessions: sessions("d") },
  { id: "uncategorised", name: "Uncategorised", sessions: sessions("e") },
];

/** The ids the payload puts in one group, by category id. */
const group = (payload, categoryId) =>
  payload.groups.find((g) => g.categoryId === categoryId).sessionIds;

describe("orderPayload", () => {
  it("sends every category, not only the two the drag touched", () => {
    const payload = orderPayload(library(), {
      sessionId: "a",
      categoryId: "cat_seminars",
      index: 1,
    });
    expect(payload.groups.map((g) => g.categoryId)).toEqual([
      "cat_lectures",
      "cat_seminars",
      null,
    ]);
  });

  it("moves a session between two categories", () => {
    const payload = orderPayload(library(), {
      sessionId: "a",
      categoryId: "cat_seminars",
      index: 1,
    });
    expect(group(payload, "cat_lectures")).toEqual(["b", "c"]);
    expect(group(payload, "cat_seminars")).toEqual(["d", "a"]);
    expect(group(payload, null)).toEqual(["e"]);
  });

  // The classic off-by-one. `index` is measured against the slots with the
  // dragged row already taken out (attachDragAndDrop filters it), so the
  // payload has to filter it out too before inserting, or every downward move
  // lands one row short of where the insertion line promised.
  it("moves a session downward within one category", () => {
    const payload = orderPayload(library(), {
      sessionId: "a",
      categoryId: "cat_lectures",
      index: 2,
    });
    expect(group(payload, "cat_lectures")).toEqual(["b", "c", "a"]);
  });

  it("moves a session upward within one category", () => {
    const payload = orderPayload(library(), {
      sessionId: "c",
      categoryId: "cat_lectures",
      index: 0,
    });
    expect(group(payload, "cat_lectures")).toEqual(["c", "a", "b"]);
  });

  it("drops into a category that has nothing in it", () => {
    const categories = library();
    categories.push({ id: "cat_empty", name: "Empty", sessions: [] });
    const payload = orderPayload(categories, {
      sessionId: "a",
      categoryId: "cat_empty",
      index: 0,
    });
    expect(group(payload, "cat_empty")).toEqual(["a"]);
    expect(group(payload, "cat_lectures")).toEqual(["b", "c"]);
  });

  // Uncategorised is only a group while something is in it, so a drop into it
  // can name a category the rendered library has no group for at all.
  it("makes a group for a category the library is not showing", () => {
    const categories = library().filter((c) => c.id !== "uncategorised");
    categories[0].sessions = sessions("a", "b", "c", "e");
    const payload = orderPayload(categories, {
      sessionId: "e",
      categoryId: null,
      index: 0,
    });
    expect(group(payload, null)).toEqual(["e"]);
    expect(group(payload, "cat_lectures")).toEqual(["a", "b", "c"]);
  });
});

// Four named categories plus the implicit bucket, as the drawer renders them.
const headings = () => [
  { id: "cat_a", name: "A", sessions: [] },
  { id: "cat_b", name: "B", sessions: [] },
  { id: "cat_c", name: "C", sessions: [] },
  { id: "cat_d", name: "D", sessions: [] },
  { id: "uncategorised", name: "Uncategorised", sessions: sessions("e") },
];

describe("categoryOrderPayload", () => {
  it("moves a heading to the front", () => {
    const payload = categoryOrderPayload(headings(), { categoryId: "cat_c", index: 0 });
    expect(payload.categoryIds).toEqual(["cat_c", "cat_a", "cat_b", "cat_d"]);
  });

  it("moves a heading to the back", () => {
    const payload = categoryOrderPayload(headings(), { categoryId: "cat_a", index: 3 });
    expect(payload.categoryIds).toEqual(["cat_b", "cat_c", "cat_d", "cat_a"]);
  });

  it("moves a heading into the middle", () => {
    const payload = categoryOrderPayload(headings(), { categoryId: "cat_a", index: 2 });
    expect(payload.categoryIds).toEqual(["cat_b", "cat_c", "cat_a", "cat_d"]);
  });

  // Uncategorised is implicit and always sorts last, so the server must never
  // be handed it as a category to renumber.
  it("leaves Uncategorised out of the payload even when it is on screen", () => {
    const payload = categoryOrderPayload(headings(), { categoryId: "cat_d", index: 1 });
    expect(payload.categoryIds).not.toContain("uncategorised");
    expect(payload.categoryIds).toEqual(["cat_a", "cat_d", "cat_b", "cat_c"]);
  });

  it("moves no session, so it sends no groups", () => {
    expect(categoryOrderPayload(headings(), { categoryId: "cat_b", index: 0 }).groups).toEqual([]);
  });
});
