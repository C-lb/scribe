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

  function paint() {
    listEl.replaceChildren();
    for (const category of library.categories) {
      listEl.append(renderCategory(category));
    }
    restoreButton.hidden = !library.canRestore;
    restoreButton.dataset.armed = "no";
    restoreButton.textContent = "Restore library";
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
    if (session.id === openId) row.dataset.open = "yes";
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
      if (row.dataset.sessionId === id) row.dataset.open = "yes";
      else delete row.dataset.open;
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
    if (!canOpen()) {
      setStatus("Stop recording to read past sessions");
      return;
    }
    if (session.live) {
      onLive();
      markOpen(null);
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
    const input = document.createElement("input");
    input.className = "inline-edit";
    input.type = "text";
    input.value = current;
    labelEl.replaceWith(input);
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
      event.stopPropagation();
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
      // Short enough to stay on one line in the 264px drawer at the 17px
      // mobile type base. The button's tooltip carries the detail.
      restoreButton.textContent = "Click again";
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
