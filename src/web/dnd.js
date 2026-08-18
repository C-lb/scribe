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
 * Native HTML5 drag events rather than pointer events: the drag image comes
 * free, the list is short, and this is a trackpad-driven desktop tool, so the
 * touch support pointer events would buy has no user here.
 *
 * `onDragState(active)` fires as a drag starts and settles. The list must not
 * be rebuilt under a dragged row, and refreshes fire on their own schedule, so
 * the caller holds its repaint the same way it holds one during a rename.
 */
export function attachDragAndDrop({ listEl, onDrop, onDragState = () => {} }) {
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

  function settle() {
    if (draggingId === null) return;
    draggingId = null;
    clearMarkers();
    onDragState(false);
  }

  function zoneFor(event) {
    return event.target.closest?.(".cat") ?? null;
  }

  listEl.addEventListener("dragstart", (event) => {
    const row = event.target.closest?.(".row");
    if (!row) return;
    depths = new WeakMap();
    draggingId = row.dataset.sessionId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggingId);
    row.dataset.dragging = "yes";
    onDragState(true);
  });

  listEl.addEventListener("dragend", (event) => {
    const row = event.target.closest?.(".row");
    if (row) delete row.dataset.dragging;
    settle();
  });

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
    if (depth <= 0) {
      delete zone.dataset.drop;
      for (const el of zone.querySelectorAll(".insert")) el.remove();
    }
  });

  listEl.addEventListener("dragover", (event) => {
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
