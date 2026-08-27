/**
 * Hand-correcting a transcript line. Same gesture as renaming a session in
 * the drawer (see history.js): double-click to open, Enter to save, Escape
 * to abandon. Nothing new to learn.
 *
 * Only the line's own trailing text node is swapped for an input -- the
 * timestamp span (and anything in it, like the flag marker) stays put, so
 * reopening the row after a save shows exactly what appendLine() would have
 * built for it.
 */

// Node.TEXT_NODE is always 3 per the DOM spec; hardcoded rather than read off
// a global `Node`, which the test environment (plain node, no jsdom) has no
// reason to provide.
const TEXT_NODE = 3;

/** The line's own text, as opposed to whatever lives inside child elements
 *  like the timestamp span. Reading only direct text-node children means this
 *  keeps working regardless of what markup the timestamp span happens to
 *  carry (a flag icon, a title attribute, ...). */
function lineText(row) {
  let text = "";
  for (const node of row.childNodes) {
    if (node.nodeType === TEXT_NODE) text += node.textContent;
  }
  return text.trim();
}

/**
 * `doc` defaults to the real browser `document` and is only ever overridden
 * in tests, which have no DOM at all in this project (see line-edit.test.js).
 * The default is a plain parameter default rather than a top-level import, so
 * evaluating this module never touches `document` -- only calling
 * createLineEdit() without a `doc` does, and the test suite always supplies
 * one.
 */
export function createLineEdit({ root, save, setStatus, doc = document }) {
  let editingRow = null;

  function editing() {
    return editingRow !== null;
  }

  function startEdit(row) {
    if (editingRow) return; // one correction open at a time
    if (!row.dataset.index) return;

    const original = lineText(row);
    const index = Number(row.dataset.index);

    // Playback owns clicks on a `.line--playable` row; while a correction is
    // open, this row must stop looking playable so a click meant for the
    // input never starts audio instead. Restored exactly as found, so a line
    // that was never clickable does not become clickable by being edited.
    const wasPlayable = row.classList.contains("line--playable");
    row.classList.remove("line--playable");

    const input = doc.createElement("input");
    input.type = "text";
    input.className = "line-edit";
    input.value = original;

    // Remove only the trailing text node(s); the timestamp span is left
    // exactly where it was.
    for (const node of [...row.childNodes]) {
      if (node.nodeType === TEXT_NODE) node.remove();
    }
    row.append(input);
    input.focus();
    input.select();

    editingRow = row;

    // A click or dblclick landing on the input is placing the cursor, not
    // reopening the row's own gesture or (while `.line--playable` is off
    // anyway, belt and braces) triggering playback behind it.
    for (const type of ["click", "dblclick", "mousedown"]) {
      input.addEventListener(type, (event) => event.stopPropagation());
    }

    let settled = false;
    async function finish(commit) {
      if (settled) return;
      settled = true;

      const typed = input.value;
      input.remove();
      row.append(doc.createTextNode(commit ? typed.trim() || original : original));
      if (wasPlayable) row.classList.add("line--playable");
      editingRow = null;

      if (!commit) return;

      try {
        const { line } = await save(index, typed.trim());
        // The server is the source of truth for the saved text (it trims
        // too) and for whether the correction cleared a failed flag.
        row.lastChild.textContent = line.text;
        row.classList.toggle("line--edited", Boolean(line.edited));
        row.classList.remove("line--failed");
      } catch (error) {
        // Roll back to what was on screen before this correction, so a
        // rejected save never leaves the reader looking at their own typo.
        row.lastChild.textContent = original;
        setStatus(`Could not save that correction: ${error.message}`);
      }
    }

    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(false));
  }

  function attach() {
    root.addEventListener("dblclick", (event) => {
      const row = event.target.closest(".line");
      if (!row || !root.contains(row)) return;
      startEdit(row);
    });
  }

  return { attach, editing };
}
