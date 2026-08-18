/**
 * The sessions drawer: renders the library the server hands over, opens a past
 * session into the panes, and renames sessions and headings in place.
 *
 * The browser stays dumb on purpose. `GET /api/library` returns the categories
 * already grouped and ordered, and every write answers with that same shape,
 * so a successful write is one repaint from one payload rather than a local
 * model that can drift from the folder on disk.
 */

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
  // An inline rename owns the list while it is open: see paint().
  let editing = false;
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
   */
  function paint() {
    if (editing) {
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
    // can rename. Every other heading is.
    if (category.id !== "uncategorised") {
      heading.title = "Double-click to rename";
      heading.addEventListener("dblclick", () =>
        editInline(heading, category.name, (name) =>
          api("PATCH", `/api/categories/${category.id}`, { name }).then(applyPayload),
        ),
      );
    }

    const rows = document.createElement("div");
    rows.className = "cat__rows";
    for (const session of category.sessions) rows.append(renderRow(session));

    section.append(heading, rows);
    return section;
  }

  function renderRow(session) {
    // A div rather than a <button>: renaming puts a text input where the label
    // is, and an input inside a button is invalid markup that swallows the
    // space bar. role and tabindex keep the keyboard behaviour a button gives.
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
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
      editInline(name, session.named ? session.title : "", (title) =>
        api("PATCH", `/api/sessions/${session.id}`, { title }).then(applyPayload),
      );
    });
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
