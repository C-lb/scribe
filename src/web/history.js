/**
 * The sessions drawer: renders the library the server hands over, opens a past
 * session into the panes, and renames sessions and headings in place.
 *
 * The browser stays dumb on purpose. `GET /api/library` returns the categories
 * already grouped and ordered, and every write answers with that same shape,
 * so a successful write is one repaint from one payload rather than a local
 * model that can drift from the folder on disk.
 */

import { attachDragAndDrop, categoryOrderPayload, orderPayload } from "./dnd.js";

function formatDuration(seconds) {
  if (seconds == null) return "";
  // Under a minute reads in seconds. Rounding a 20-second session to "0 min"
  // says the recording holds nothing, which is the one thing it does not mean.
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} sec`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function createHistory({ root, toggle, setStatus, canOpen, onOpen, onLive }) {
  const listEl = root.querySelector("#history-list");
  const restoreButton = root.querySelector("#history-restore");
  const newCategoryButton = root.querySelector("#history-new-category");
  let library = { categories: [], canRestore: false };
  let openId = null;
  // An inline rename owns the list while it is open: see paint().
  let editing = false;
  // So does a drag, for the same reason.
  let dragging = false;
  let paintDeferred = false;

  // Remembered so the drawer is where the user left it across reloads.
  const OPEN_KEY = "scribe.sidebar.open";
  const setOpen = (open) => {
    document.body.dataset.sidebar = open ? "open" : "closed";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      // Private browsing can refuse to store. Forgetting the drawer across
      // reloads is a smaller failure than the drawer refusing to move.
    }
  };

  let remembered = null;
  try {
    remembered = localStorage.getItem(OPEN_KEY);
  } catch {
    remembered = null;
  }
  setOpen(remembered !== "0");

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

  /**
   * A repaint replaces the whole list, so one landing while a rename is open
   * would destroy the input under the user's hands and either lose the edit or
   * commit it by accident on the removal's blur. Refreshes fire on their own
   * schedule (a recording starting or stopping), so the repaint waits for the
   * edit to settle rather than the edit hoping no refresh lands.
   *
   * A drag holds the list for the same reason: a repaint mid-drag would pull
   * the dragged row out from under the pointer and end the drag on a node the
   * browser no longer has.
   */
  function paint() {
    if (editing || dragging) {
      paintDeferred = true;
      return;
    }
    paintDeferred = false;
    listEl.replaceChildren();
    for (const category of library.categories) {
      listEl.append(renderCategory(category));
    }
    restoreButton.hidden = !library.canRestore;
    disarmRestore();
    // The rows and headings the menu was raised from are gone, so an open menu
    // would sit on screen anchored to a detached node, and an armed item in it
    // would still be armed. Arming is a moment here too.
    closeMenu();
  }

  /** Whatever the last skipped repaint was waiting to draw, draw it now. */
  function flushPaint() {
    if (paintDeferred) paint();
  }

  function renderCategory(category) {
    const section = document.createElement("section");
    section.className = "cat";
    section.dataset.categoryId = category.id;

    const heading = document.createElement("h3");
    heading.className = "cat__name";
    heading.textContent = category.name;
    // "Uncategorised" is not a heading the user made, so it is not one they
    // can rename, drag, or reorder. Every other heading is.
    if (category.id !== "uncategorised") {
      heading.title = "Drag to reorder, double-click to rename, right-click for more";
      heading.draggable = true;
      // Focusable so the browser's own Menu key and Shift+F10 have somewhere to
      // raise the heading menu from, which is where the keyboard route to
      // reordering lives. Rows already take focus for the same reason.
      heading.tabIndex = 0;
      heading.addEventListener("dblclick", () => renameCategory(category.id));
      heading.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        renameCategory(category.id);
      });
      heading.addEventListener("contextmenu", (event) =>
        openMenu(event, heading, categoryItems(category)),
      );
    }

    const rows = document.createElement("div");
    rows.className = "cat__rows";
    for (const session of category.sessions) rows.append(renderRow(session, category));

    section.append(heading, rows);
    return section;
  }

  function renderRow(session, category) {
    // A div rather than a <button>: renaming puts a text input where the label
    // is, and an input inside a button is invalid markup that swallows the
    // space bar. role and tabindex keep the keyboard behaviour a button gives.
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.draggable = true;
    row.dataset.sessionId = session.id;
    if (session.id === openId) {
      row.dataset.open = "yes";
      // The highlight is a background step, so the selection needs to reach a
      // screen reader some other way than colour and weight.
      row.setAttribute("aria-current", "true");
    }
    if (session.live) row.dataset.live = "yes";
    row.title = session.title;

    const name = document.createElement("span");
    name.className = "row__name";
    name.textContent = session.title;

    const meta = document.createElement("span");
    meta.className = "row__meta";
    meta.textContent = session.live ? "Recording" : formatDuration(session.audioSeconds);

    row.append(name, meta);
    row.addEventListener("click", () => open(session));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open(session);
    });
    row.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      renameSession(session);
    });
    row.addEventListener("contextmenu", (event) => openMenu(event, row, sessionItems(session, category)));
    return row;
  }

  /**
   * Moves the open highlight without rebuilding the list. A full repaint here
   * would replace the row under the user's pointer between the two clicks of a
   * double-click, and the rename would then edit a detached node.
   */
  function markOpen(id) {
    openId = id;
    for (const row of listEl.querySelectorAll(".row")) {
      if (row.dataset.sessionId === id) {
        row.dataset.open = "yes";
        row.setAttribute("aria-current", "true");
      } else {
        delete row.dataset.open;
        row.removeAttribute("aria-current");
      }
    }
  }

  function applyPayload(payload) {
    library = payload;
    paint();
  }

  /* ── Dragging ──────────────────────────────────────────────────────────── */

  attachDragAndDrop({
    listEl,
    onDragState: (active) => {
      dragging = active;
      if (!active) flushPaint();
    },
    onDrop: async (drop) => {
      try {
        applyPayload(
          await api("PUT", "/api/library/order", orderPayload(library.categories, drop)),
        );
      } catch (error) {
        setStatus(`Could not move that session: ${error.message}`);
        // The rows are still sitting where the drag left them on screen, so
        // the list is put back to whatever the server actually holds.
        await refresh().catch(() => {});
      }
    },
    onDropCategory: (drop) => moveCategoryTo(drop),
  });

  /**
   * One route for both ways a heading moves, the drag and the two menu items,
   * so the payload is built in one place and the failure is reported once.
   */
  async function moveCategoryTo(drop) {
    try {
      applyPayload(
        await api("PUT", "/api/library/order", categoryOrderPayload(library.categories, drop)),
      );
    } catch (error) {
      setStatus(`Could not move that category: ${error.message}`);
      // The headings are still sitting where the drag left them on screen, so
      // the list is put back to whatever the server actually holds.
      await refresh().catch(() => {});
    }
  }

  /* ── Renaming ──────────────────────────────────────────────────────────── */

  /**
   * Looked up fresh rather than captured: a repaint between opening the menu
   * and choosing Rename would leave a captured node detached, and the edit
   * would then happen somewhere off screen.
   */
  function renameSession(session) {
    const nameEl = listEl.querySelector(
      `.row[data-session-id="${cssId(session.id)}"] .row__name`,
    );
    if (!nameEl) return;
    editInline(nameEl, session.named ? session.title : "", (title) =>
      api("PATCH", `/api/sessions/${session.id}`, { title }).then(applyPayload),
    );
  }

  function renameCategory(categoryId) {
    const heading = listEl.querySelector(
      `.cat[data-category-id="${cssId(categoryId)}"] .cat__name`,
    );
    if (!heading) return;
    editInline(heading, heading.textContent, (name) =>
      api("PATCH", `/api/categories/${categoryId}`, { name }).then(applyPayload),
    );
  }

  /**
   * The rename editor's shape (replace, edit, commit on settle, roll back on
   * failure), widened to a textarea because a term list is several lines, not
   * one. It replaces the session rows rather than the heading: the heading
   * text itself is not what is being edited here, and the rows are the one
   * other block already sitting directly under it.
   */
  function editTerms(categoryId) {
    const section = listEl.querySelector(`.cat[data-category-id="${cssId(categoryId)}"]`);
    const rows = section?.querySelector(".cat__rows");
    const category = library.categories.find((c) => c.id === categoryId);
    if (!section || !rows || !category) return;

    const terms = category.terms ?? [];
    const textarea = document.createElement("textarea");
    textarea.className = "inline-edit inline-edit--terms";
    textarea.value = terms.join("\n");
    textarea.placeholder = "One term per line";
    textarea.setAttribute("aria-label", `Terms for ${category.name}`);
    rows.replaceWith(textarea);
    editing = true;
    textarea.focus();

    for (const type of ["click", "dblclick", "mousedown"]) {
      textarea.addEventListener(type, (event) => event.stopPropagation());
    }

    let settled = false;
    const finish = async (save) => {
      if (settled) return;
      settled = true;
      const value = textarea.value;
      textarea.replaceWith(rows);
      editing = false;

      if (!save) {
        flushPaint();
        return;
      }

      const cleaned = value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      try {
        const payload = await api("PATCH", `/api/categories/${categoryId}`, { terms: cleaned });
        applyPayload(payload);
        // The count comes back from the server rather than from `cleaned`,
        // because updateCategory also caps the list and each entry's length:
        // this reports what was actually kept, not what was typed.
        const saved = payload.categories.find((c) => c.id === categoryId)?.terms ?? [];
        setStatus(`Saved ${saved.length} term${saved.length === 1 ? "" : "s"} for ${category.name}.`);
      } catch (error) {
        setStatus(`Could not save that term list: ${error.message}`);
        await refresh().catch(() => {});
      } finally {
        flushPaint();
      }
    };

    textarea.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        finish(false);
        return;
      }
      // Plain Enter has to stay a newline, unlike the single-line rename
      // editor: a term list needs multiple lines. Cmd/Ctrl+Enter is the save
      // shortcut instead.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        finish(true);
      }
    });
    textarea.addEventListener("blur", () => finish(true));
  }

  /* ── Context menu ──────────────────────────────────────────────────────── */

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);

  let menuAnchor = null;
  let menuOpenedAt = 0;

  function closeMenu({ restoreFocus = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    const anchor = menuAnchor;
    menuAnchor = null;
    if (restoreFocus && anchor?.isConnected) anchor.focus();
  }

  document.addEventListener("click", () => {
    // Some browsers send a click of their own alongside the ctrl-click that
    // opened the menu. Anything in the first moment is that click, not the
    // user's next one.
    if (performance.now() - menuOpenedAt < 250) return;
    closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu({ restoreFocus: true });
      return;
    }
    // The way into an open menu when focus is still on the row that raised it,
    // which is the standard menu-button behaviour and the second route in if
    // the pointer test above ever reads a keyboard press as a pointer.
    if (menu.hidden || document.activeElement !== menuAnchor) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll(".menu__item")];
    (event.key === "ArrowDown" ? buttons[0] : buttons[buttons.length - 1])?.focus();
  });
  // A right-click elsewhere raises no click of its own in Chrome or Safari, so
  // without this the menu would sit on screen beside the browser's own until
  // the next left click. Row and heading right-clicks never reach here: those
  // stop propagating in openMenu.
  document.addEventListener("contextmenu", (event) => {
    if (!menu.contains(event.target)) closeMenu();
  });
  // A fixed menu survives both of these and ends up pointing at nothing.
  window.addEventListener("resize", () => closeMenu());
  window.addEventListener("blur", () => closeMenu());
  // Scrolling the drawer would leave a fixed menu pointing at nothing. In the
  // capture phase because scroll does not bubble.
  root.addEventListener("scroll", () => closeMenu(), true);

  /**
   * `items` is a list of `{ label, run }`. Both menus are built from the same
   * shape so there is one keyboard behaviour and one set of styles, not two.
   *
   * Reachable from the keyboard without a new interaction to learn: the
   * browser raises `contextmenu` from the Menu key and Shift+F10 on whatever
   * has focus, and rows already take focus. Arrow keys move between items,
   * Escape closes and hands focus back to the row.
   */
  function openMenu(event, anchor, items) {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    menuAnchor = anchor;
    menu.replaceChildren();

    for (const entry of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu__item";
      button.setAttribute("role", "menuitem");
      button.textContent = entry.label;
      button.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        // An armed item wants a second click, so it closes the menu itself.
        if (entry.run(button) === false) return;
        closeMenu();
      });
      menu.append(button);
    }

    menu.hidden = false;
    menuOpenedAt = performance.now();

    // Chrome reports the focused element's position for a keyboard-raised
    // contextmenu, so the pointer coordinates are usable either way. Firefox
    // reports 0,0, and that is the only case the menu hangs off the element.
    const rect = anchor.getBoundingClientRect();
    const hasPoint = event.clientX > 0 || event.clientY > 0;
    place(hasPoint ? event.clientX : rect.left, hasPoint ? event.clientY : rect.bottom);

    // A pointer-raised contextmenu names its pointer; a keyboard-raised one
    // has none. `detail` cannot do this job: Chrome reports 0 for a real
    // right-click too, measured. Anything this does not recognise falls to
    // the keyboard side on purpose, because focusing the first item costs a
    // mouse user a focus ring while not focusing it costs a keyboard user the
    // whole menu.
    const pointer = event.pointerType;
    const fromPointer = pointer === "mouse" || pointer === "pen" || pointer === "touch";
    if (!fromPointer) menu.querySelector(".menu__item")?.focus();
  }

  /** Clamped so the menu never hangs off the viewport or under the edge. */
  function place(x, y) {
    const gap = 8;
    const box = menu.getBoundingClientRect();
    const left = Math.max(gap, Math.min(x, window.innerWidth - box.width - gap));
    const top = Math.max(gap, Math.min(y, window.innerHeight - box.height - gap));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  menu.addEventListener("keydown", (event) => {
    const buttons = [...menu.querySelectorAll(".menu__item")];
    const at = buttons.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    }
  });

  /**
   * A menu item that wants a second click, the same shape the restore control
   * uses, because confirm() blocks the page and nothing else here does.
   *
   * `tone` says how the armed state reads. Red is the danger tone and belongs
   * to the one item that removes something; an item that removes nothing gets
   * the quiet tone instead, so the colour keeps meaning what it says.
   *
   * Arming is a moment, not a mode: the menu is rebuilt from scratch every time
   * it opens and closes on any click outside it, so an armed item that is not
   * clicked again is gone by the next interaction. Choosing a different item in
   * the same menu disarms this one for the same reason, since that click closes
   * the menu too.
   */
  function confirmItem({ label, armedLabel, act, tone = "danger" }) {
    return {
      label,
      run: (button) => {
        if (button.dataset.armed !== "yes") {
          button.dataset.armed = "yes";
          button.dataset.tone = tone;
          button.textContent = armedLabel;
          // The label just grew, so the menu is placed again against its own
          // corner rather than being allowed to hang off the viewport.
          place(
            Number.parseFloat(menu.style.left) || 0,
            Number.parseFloat(menu.style.top) || 0,
          );
          return false;
        }
        act();
        return true;
      },
    };
  }

  function sessionItems(session, category) {
    const items = [{ label: "Rename", run: () => renameSession(session) }];

    for (const other of library.categories) {
      if (other.id === category.id) continue;
      items.push({
        label: `Move to ${other.name}`,
        run: () => moveSession(session, other.id === "uncategorised" ? null : other.id),
      });
    }
    // Uncategorised is only a group while something is in it, so on the last
    // session out of a category there is no heading left to aim at.
    if (category.id !== "uncategorised" && !library.categories.some((c) => c.id === "uncategorised")) {
      items.push({ label: "Move to Uncategorised", run: () => moveSession(session, null) });
    }

    items.push({ label: "Reveal in Finder", run: () => reveal(session) });

    // Never offered on the session being recorded: hiding it would take the
    // row out from under the user mid-lecture, and that row is also the only
    // route back to the live panes.
    if (!session.live) {
      items.push(
        confirmItem({
          label: "Hide from library",
          armedLabel: "Click again to hide",
          // Nothing is destroyed here, so the armed state does not borrow the
          // delete red.
          tone: "quiet",
          act: () => hideSession(session),
        }),
      );
    }
    return items;
  }

  /** Whatever the library holds for that id right now, or null if it is gone. */
  function currentSession(id) {
    for (const category of library.categories) {
      const found = category.sessions.find((s) => s.id === id);
      if (found) return found;
    }
    return null;
  }

  /**
   * Takes the row out of the drawer and leaves the recording alone. There is no
   * un-hide here on purpose: nothing is destroyed, the folder keeps everything,
   * and "Restore library to when Scribe opened" already brings back anything
   * hidden since launch.
   */
  async function hideSession(session) {
    // The menu was built from a render-time row, and a repaint held back by an
    // open rename or a drag in flight can leave that row older than the
    // library. Recording state is the one field where acting on the stale copy
    // matters: hiding the live row takes it out from under the user and takes
    // the only route back to the live panes with it. So it is read fresh, the
    // same way renameSession looks its node up fresh rather than capturing it.
    const current = currentSession(session.id);
    if (!current) {
      setStatus("That session is no longer in the library");
      return;
    }
    if (current.live) {
      setStatus("Stop recording before hiding that session");
      return;
    }
    try {
      applyPayload(await api("PATCH", `/api/sessions/${session.id}`, { hidden: true }));
      // Names where the recording still is, so it is plain that the row went
      // and the audio did not.
      setStatus(`Hidden. The recording is still in sessions/${session.id}.`);
    } catch (error) {
      setStatus(`Could not hide that session: ${error.message}`);
      await refresh().catch(() => {});
    }
  }

  async function moveSession(session, categoryId) {
    try {
      applyPayload(await api("PATCH", `/api/sessions/${session.id}`, { categoryId }));
    } catch (error) {
      setStatus(`Could not move that session: ${error.message}`);
      await refresh().catch(() => {});
    }
  }

  async function reveal(session) {
    try {
      await api("POST", `/api/sessions/${session.id}/reveal`);
    } catch (error) {
      setStatus(`Could not open the folder: ${error.message}`);
    }
  }

  function categoryItems(category) {
    const items = [
      { label: "Rename", run: () => renameCategory(category.id) },
      { label: "Edit terms", run: () => editTerms(category.id) },
    ];

    // The keyboard's way to do what a heading drag does. Uncategorised is not
    // in this list at all, so it is never a position either item can reach.
    const ids = library.categories.map((c) => c.id).filter((id) => id !== "uncategorised");
    const at = ids.indexOf(category.id);
    if (at > 0) {
      items.push({ label: "Move up", run: () => moveCategoryTo({ categoryId: category.id, index: at - 1 }) });
    }
    if (at >= 0 && at < ids.length - 1) {
      items.push({ label: "Move down", run: () => moveCategoryTo({ categoryId: category.id, index: at + 1 }) });
    }

    items.push(
      confirmItem({
        label: "Delete category",
        armedLabel: "Click again to delete",
        act: () => deleteCategory(category.id),
      }),
    );
    return items;
  }

  /** Never touches recordings: the sessions fall back to Uncategorised. */
  async function deleteCategory(categoryId) {
    try {
      applyPayload(await api("DELETE", `/api/categories/${categoryId}`));
    } catch (error) {
      setStatus(`Could not delete that category: ${error.message}`);
      await refresh().catch(() => {});
    }
  }

  /** Ids are server-made (`cat-…`, timestamps), but a selector is a selector. */
  function cssId(value) {
    return CSS.escape(value);
  }

  /**
   * The whole recording restriction. Lifting it later is this function plus
   * the overlay UI, not a hunt through the view logic.
   */
  async function open(session) {
    // Returning to the live pane comes first. The guard below protects the
    // recording from being navigated away from, and a row is only marked live
    // while that recording is running, so guarding this branch would refuse
    // the user the one route back to what they are recording.
    if (session.live) {
      onLive();
      markOpen(null);
      return;
    }
    if (!canOpen()) {
      setStatus("Stop recording to read past sessions");
      return;
    }
    try {
      const payload = await api("GET", `/api/sessions/${session.id}`);
      onOpen(payload);
      markOpen(session.id);
    } catch (error) {
      setStatus(`Could not open that session: ${error.message}`);
    }
  }

  /** One interaction for both rows and headings, rather than two to learn. */
  function editInline(labelEl, current, commit) {
    // Taken before the label leaves the tree: a detached node has no
    // ancestors, so closest() would come back null in finish().
    const row = labelEl.closest(".row");

    const input = document.createElement("input");
    input.className = "inline-edit";
    input.type = "text";
    input.value = current;
    labelEl.replaceWith(input);
    // A draggable ancestor eats the pointer, so text inside the input cannot
    // be selected by dragging until the row stops being draggable.
    if (row) row.draggable = false;
    editing = true;
    input.focus();
    input.select();

    // The row itself is clickable, and clicking into the input to place the
    // cursor must not also open the session behind it.
    for (const type of ["click", "dblclick", "mousedown"]) {
      input.addEventListener(type, (event) => event.stopPropagation());
    }

    let settled = false;
    const finish = async (save) => {
      if (settled) return;
      settled = true;
      const value = input.value;

      // The new name goes up straight away and the server payload confirms it.
      // An empty value is the exception: only the server knows the date default
      // it reverts to, so that one waits for the payload.
      if (save && value.trim()) {
        labelEl.textContent = value.trim();
        if (row) row.title = value.trim();
      }

      input.replaceWith(labelEl);
      if (row) row.draggable = true;
      editing = false;

      if (!save) {
        flushPaint();
        return;
      }
      try {
        await commit(value);
      } catch (error) {
        // Optimism rolled back: the reason goes where every other reason goes.
        setStatus(`Could not save that name: ${error.message}`);
        await refresh().catch(() => {});
      } finally {
        // A refresh that arrived mid-edit was held back; it draws now, on top
        // of whatever the commit already painted.
        flushPaint();
      }
    };

    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  newCategoryButton.addEventListener("click", async () => {
    const before = new Set(library.categories.map((c) => c.id));
    try {
      applyPayload(await api("POST", "/api/categories", { name: "New category" }));
    } catch (error) {
      setStatus(`Could not add a category: ${error.message}`);
      return;
    }
    // Straight into a rename: a heading called "New category" is not a name.
    // The new id is whichever one the payload has that the old library did
    // not, since the server picks it and Uncategorised can sort after it.
    const created = library.categories.find((c) => !before.has(c.id));
    if (created) renameCategory(created.id);
  });

  /** Arming is a moment, not a mode: anything but a second click drops it. */
  function disarmRestore() {
    if (restoreButton.dataset.armed !== "yes") return;
    restoreButton.dataset.armed = "no";
    restoreButton.textContent = "Restore library";
  }

  restoreButton.addEventListener("blur", disarmRestore);
  document.addEventListener("click", (event) => {
    // The arming click's own target is the button, so this never disarms the
    // click that just armed it.
    if (event.target === restoreButton || restoreButton.contains(event.target)) return;
    disarmRestore();
  });

  restoreButton.addEventListener("click", async () => {
    // Two-step inline confirm. A native confirm() blocks the page and is out
    // of keeping with how the rest of this app reports things.
    if (restoreButton.dataset.armed !== "yes") {
      restoreButton.dataset.armed = "yes";
      // Short enough to stay on one line in the 264px drawer at the 17px
      // mobile type base. The button's tooltip carries the detail.
      restoreButton.textContent = "Click again";
      return;
    }
    disarmRestore();
    try {
      applyPayload(await api("POST", "/api/library/restore"));
      setStatus("Library restored to when Scribe opened");
    } catch (error) {
      setStatus(`Could not restore: ${error.message}`);
      paint();
    }
  });

  return {
    refresh,
    api,
    applyPayload,
    /** The scrim and any other outside closer go through here, so the drawer's
     *  remembered state stays in step with what is on screen. */
    close: () => setOpen(false),
    /** The panes went back to live without the drawer asking (a new recording
     *  started), so drop the open highlight without calling onLive again. */
    clearOpen: () => markOpen(null),
    get library() {
      return library;
    },
  };
}
