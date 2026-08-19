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

/**
 * The completed drag as one payload for `PUT /api/library/order`. Pure: the
 * rendered library and the drop go in, the payload comes out, so the index
 * arithmetic that decides where a row lands is testable without a DOM.
 *
 * One drag renumbers rows across two categories, so it goes as one payload and
 * the library cannot be left half-applied. Every category is sent, not just the
 * two the drag touched, because the server numbers each group from zero and a
 * group left out would keep stale numbers beside fresh ones.
 *
 * The dragged row is filtered out of every group before it is inserted, which
 * is what `index` is already measured against: attachDragAndDrop skips the
 * dragged row when it reads the slots, so a downward move within one category
 * counts the same rows on both sides and does not land one slot early.
 */
export function orderPayload(categories, { sessionId, categoryId, index }) {
  const groups = categories.map((category) => ({
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

/**
 * A completed heading drag as one payload for `PUT /api/library/order`. Pure
 * for the same reason `orderPayload` is: the index arithmetic that decides
 * where a heading lands is where an off-by-one would hide.
 *
 * `groups` goes out empty because a heading drag moves no session between
 * categories and no row within one, and the server renumbers only the groups
 * it is given. Uncategorised is not a category the user made: it has no id, it
 * always sorts last, and it is filtered out here so it can never be sent.
 *
 * The dragged id is filtered out before it is inserted, which is what `index`
 * is already measured against: attachDragAndDrop skips the dragged heading
 * when it reads the slots, so a downward move counts the same headings on both
 * sides and does not land one slot early.
 */
export function categoryOrderPayload(categories, { categoryId, index }) {
  const categoryIds = categories
    .map((category) => category.id)
    .filter((id) => id !== "uncategorised" && id !== categoryId);
  categoryIds.splice(index, 0, categoryId);
  return { groups: [], categoryIds };
}

/**
 * Native HTML5 drag events rather than pointer events: the drag image comes
 * free, the list is short, and this is a trackpad-driven desktop tool, so the
 * touch support pointer events would buy has no user here.
 *
 * `onDragState(active)` fires as a drag starts and settles. The list must not
 * be rebuilt under a dragged row, and refreshes fire on their own schedule, so
 * the caller holds its repaint the same way it holds one during a rename.
 *
 * Two kinds of drag share these listeners: a session row moving between and
 * within categories, and a heading reordering the categories themselves. They
 * are kept apart by `mode`, decided once at dragstart from what the drag
 * started on and read by every handler after it. A row drag therefore never
 * consults heading slots, a heading drag never lights a category as a row drop
 * zone, and neither can be reached from the other's gesture.
 */
export function attachDragAndDrop({
  listEl,
  onDrop,
  onDropCategory = () => {},
  onDragState = () => {},
}) {
  // "row", "category", or null when nothing is being dragged.
  let mode = null;
  let draggingId = null;
  // dragleave fires when the cursor crosses a child element, so depth is
  // counted per zone rather than trusted per event. A drop consumes no
  // dragleave, so the counts are thrown away at the start of every drag
  // rather than trusted to unwind on their own.
  let depths = new WeakMap();

  /** The dragged row is still in the list, so it is never its own neighbour. */
  function slotsIn(zone) {
    return [...zone.querySelectorAll(".row")].filter((row) => row.dataset.sessionId !== draggingId);
  }

  function targetIndex(zone, pointerY) {
    const rows = slotsIn(zone);
    return {
      rows,
      index: insertionIndex(
        pointerY,
        rows.map((row) => row.getBoundingClientRect()),
      ),
    };
  }

  function clearMarkers() {
    for (const el of listEl.querySelectorAll("[data-drop]")) delete el.dataset.drop;
    for (const el of listEl.querySelectorAll(".insert")) el.remove();
  }

  /**
   * The headings a heading drag can land against, in visual order. Uncategorised
   * is not one of them: it is implicit, has no id, and always sorts last, so it
   * is neither a slot nor an end stop the drop can pass. The dragged heading is
   * skipped so it is never its own neighbour, exactly as rows are.
   */
  function categorySlots() {
    return [...listEl.querySelectorAll(".cat")].filter(
      (section) =>
        section.dataset.categoryId !== "uncategorised" &&
        section.dataset.categoryId !== draggingId,
    );
  }

  function categoryTargetIndex(pointerY) {
    const sections = categorySlots();
    return {
      sections,
      index: insertionIndex(
        pointerY,
        // The heading's own rectangle, not the whole section's: the drop lands
        // where the name is, so a tall category does not swallow the slot after
        // it just by holding more rows.
        sections.map((section) => section.querySelector(".cat__name").getBoundingClientRect()),
      ),
    };
  }

  function uncategorisedSection() {
    return listEl.querySelector('.cat[data-category-id="uncategorised"]');
  }

  function settle() {
    if (draggingId === null) return;
    draggingId = null;
    mode = null;
    clearMarkers();
    onDragState(false);
  }

  function zoneFor(event) {
    return event.target.closest?.(".cat") ?? null;
  }

  listEl.addEventListener("dragstart", (event) => {
    const row = event.target.closest?.(".row");
    if (row) {
      depths = new WeakMap();
      mode = "row";
      draggingId = row.dataset.sessionId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggingId);
      row.dataset.dragging = "yes";
      onDragState(true);
      return;
    }

    const heading = event.target.closest?.(".cat__name");
    const section = heading?.closest(".cat");
    // Uncategorised is implicit, so its heading is not draggable. The renderer
    // leaves it undraggable too; this is the second gate, not the only one.
    if (!section || section.dataset.categoryId === "uncategorised") return;
    depths = new WeakMap();
    mode = "category";
    draggingId = section.dataset.categoryId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggingId);
    heading.dataset.dragging = "yes";
    onDragState(true);
  });

  listEl.addEventListener("dragend", (event) => {
    const row = event.target.closest?.(".row");
    if (row) delete row.dataset.dragging;
    const heading = event.target.closest?.(".cat__name");
    if (heading) delete heading.dataset.dragging;
    settle();
  });

  listEl.addEventListener("dragenter", (event) => {
    if (mode !== "row") return;
    const zone = zoneFor(event);
    if (!zone || !draggingId) return;
    depths.set(zone, (depths.get(zone) ?? 0) + 1);
    zone.dataset.drop = "yes";
  });

  listEl.addEventListener("dragleave", (event) => {
    if (mode !== "row") return;
    const zone = zoneFor(event);
    if (!zone) return;
    const depth = (depths.get(zone) ?? 0) - 1;
    depths.set(zone, depth);
    if (depth <= 0) {
      delete zone.dataset.drop;
      for (const el of zone.querySelectorAll(".insert")) el.remove();
    }
  });

  listEl.addEventListener("dragover", (event) => {
    if (mode === "category") {
      if (!draggingId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";

      const { sections, index } = categoryTargetIndex(event.clientY);
      for (const el of listEl.querySelectorAll(".insert")) el.remove();
      const line = document.createElement("div");
      line.className = "insert";
      // Past the last real heading the line stops in front of Uncategorised
      // rather than after it, which is the same thing the payload says.
      listEl.insertBefore(line, sections[index] ?? uncategorisedSection() ?? null);
      return;
    }
    if (mode !== "row") return;

    const zone = zoneFor(event);
    if (!zone || !draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    // Drawn from the same slots the drop will use, so the line never promises
    // a position the drop then does not honour.
    const { rows, index } = targetIndex(zone, event.clientY);

    for (const el of listEl.querySelectorAll(".insert")) el.remove();
    const line = document.createElement("div");
    line.className = "insert";
    const rowsEl = zone.querySelector(".cat__rows");
    rowsEl.insertBefore(line, rows[index] ?? null);
  });

  listEl.addEventListener("drop", (event) => {
    if (mode === "category") {
      if (!draggingId) return;
      event.preventDefault();
      const { index } = categoryTargetIndex(event.clientY);
      const categoryId = draggingId;
      settle();
      onDropCategory({ categoryId, index });
      return;
    }
    if (mode !== "row") return;

    const zone = zoneFor(event);
    if (!zone || !draggingId) return;
    event.preventDefault();

    const { index } = targetIndex(zone, event.clientY);
    const sessionId = draggingId;
    const categoryId = zone.dataset.categoryId;

    // The drag is over before the write goes out, so the payload's repaint is
    // not held back waiting for a dragend that has not fired yet.
    settle();
    onDrop({
      sessionId,
      categoryId: categoryId === "uncategorised" ? null : categoryId,
      index,
    });
  });
}
