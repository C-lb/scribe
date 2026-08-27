import { describe, it, expect, vi, afterEach } from "vitest";
import { createLineEdit } from "../src/web/line-edit.js";
import { createLineActivator } from "../src/web/line-click.js";

// The project runs vitest in the "node" environment (see vitest.config.ts) and
// carries no jsdom/happy-dom dependency, so createFlagKey's peers
// (dnd.test.js, playback.test.js, flags.test.js) all drive their modules with
// plain fake objects rather than a real DOM. line-edit.js is heavier than
// those -- it builds and tears down real nodes -- so the fake here is a
// slightly bigger version of the same idea: enough of the Element/Text API
// surface for line-edit.js to run unmodified against it, nothing more.
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this._listeners = new Map();
  }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  // Bubbles from the node dispatchEvent was called on up through parentNode,
  // the same order a delegated listener on a container relies on. A handler
  // calling stopPropagation() halts the walk, matching the real DOM.
  dispatchEvent(event) {
    if (event.target === undefined) event.target = this;
    let node = this;
    while (node) {
      event.currentTarget = node;
      for (const handler of (node._listeners.get(event.type) ?? []).slice()) {
        if (event._stopped) break;
        handler(event);
      }
      if (event._stopped || event.bubbles === false) break;
      node = node.parentNode;
    }
    return true;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    const i = siblings.indexOf(this);
    if (i !== -1) siblings.splice(i, 1);
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  constructor(text) {
    super(TEXT_NODE);
    this.textContent = text;
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super(ELEMENT_NODE);
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.dataset = {};
    this.value = "";
    this.title = "";
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
      toggle: (n, force) => {
        const on = force === undefined ? !classes.has(n) : force;
        if (on) classes.add(n);
        else classes.delete(n);
        return on;
      },
    };
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE);
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  matches(selector) {
    return selector.startsWith(".")
      ? this.classList.contains(selector.slice(1))
      : this.tagName === selector.toUpperCase();
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  focus() {}
  select() {}
  // Real blur does not bubble, and line-edit.js listens for it directly on
  // the input rather than delegating, so this only needs to fire the
  // listeners registered on this node itself.
  blur() {
    this.dispatchEvent(fakeEvent("blur", { bubbles: false }));
  }
}

const fakeDoc = () => ({
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
});

function fakeEvent(type, props = {}) {
  return {
    type,
    bubbles: true,
    target: undefined,
    _stopped: false,
    stopPropagation() {
      this._stopped = true;
    },
    ...props,
  };
}

function paneWithLine(text = "makes RAF tolerant") {
  const root = new FakeElement("div");
  const row = new FakeElement("p");
  row.classList.add("line");
  row.dataset.index = "0";
  const stamp = new FakeElement("span");
  stamp.classList.add("line__time");
  stamp.append(new FakeText("00:00"));
  row.append(stamp, new FakeText(text));
  root.append(row);
  return root;
}

describe("createLineEdit", () => {
  it("turns a double-clicked line into an input holding its current text", () => {
    const root = paneWithLine();
    createLineEdit({ root, save: vi.fn(), setStatus: vi.fn(), doc: fakeDoc() }).attach();
    root.querySelector(".line").dispatchEvent(fakeEvent("dblclick"));
    expect(root.querySelector("input").value).toBe("makes RAF tolerant");
  });

  it("saves on Enter and puts the new text back in the line", async () => {
    const root = paneWithLine();
    const save = vi.fn().mockResolvedValue({ line: { index: 0, text: "makes Raft tolerant", edited: true } });
    createLineEdit({ root, save, setStatus: vi.fn(), doc: fakeDoc() }).attach();
    root.querySelector(".line").dispatchEvent(fakeEvent("dblclick"));
    const input = root.querySelector("input");
    input.value = "makes Raft tolerant";
    input.dispatchEvent(fakeEvent("keydown", { key: "Enter" }));
    await Promise.resolve();
    expect(save).toHaveBeenCalledWith(0, "makes Raft tolerant");
  });

  it("marks the row edited with the server's own text once the save resolves", async () => {
    const root = paneWithLine();
    const save = vi.fn().mockResolvedValue({ line: { index: 0, text: "makes Raft tolerant", edited: true } });
    createLineEdit({ root, save, setStatus: vi.fn(), doc: fakeDoc() }).attach();
    const row = root.querySelector(".line");
    row.classList.add("line--failed");
    row.dispatchEvent(fakeEvent("dblclick"));
    root.querySelector("input").dispatchEvent(fakeEvent("keydown", { key: "Enter" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(row.textContent).toContain("makes Raft tolerant");
    expect(row.classList.contains("line--edited")).toBe(true);
    expect(row.classList.contains("line--failed")).toBe(false);
  });

  it("abandons on Escape without saving", () => {
    const root = paneWithLine();
    const save = vi.fn();
    createLineEdit({ root, save, setStatus: vi.fn(), doc: fakeDoc() }).attach();
    root.querySelector(".line").dispatchEvent(fakeEvent("dblclick"));
    root.querySelector("input").dispatchEvent(fakeEvent("keydown", { key: "Escape" }));
    expect(save).not.toHaveBeenCalled();
    expect(root.querySelector(".line").textContent).toContain("makes RAF tolerant");
  });

  it("abandons on blur without saving, same as Escape", () => {
    const root = paneWithLine();
    const save = vi.fn();
    const lineEdit = createLineEdit({ root, save, setStatus: vi.fn(), doc: fakeDoc() });
    lineEdit.attach();
    root.querySelector(".line").dispatchEvent(fakeEvent("dblclick"));
    const input = root.querySelector("input");
    input.value = "something the user typed but never committed";
    input.blur();
    expect(save).not.toHaveBeenCalled();
    expect(root.querySelector("input")).toBeNull();
    expect(root.querySelector(".line").textContent).toContain("makes RAF tolerant");
    expect(lineEdit.editing()).toBe(false);
  });

  it("restores the original text and says so when the save fails", async () => {
    const root = paneWithLine();
    const setStatus = vi.fn();
    const save = vi.fn().mockRejectedValue(new Error("Stop recording before correcting a line"));
    createLineEdit({ root, save, setStatus, doc: fakeDoc() }).attach();
    root.querySelector(".line").dispatchEvent(fakeEvent("dblclick"));
    const input = root.querySelector("input");
    input.value = "anything";
    input.dispatchEvent(fakeEvent("keydown", { key: "Enter" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(setStatus).toHaveBeenCalledWith(
      "Could not save that correction: Stop recording before correcting a line",
    );
    expect(root.querySelector(".line").textContent).toContain("makes RAF tolerant");
  });

  it("ignores a double-click that lands outside any line", () => {
    const root = paneWithLine();
    createLineEdit({ root, save: vi.fn(), setStatus: vi.fn(), doc: fakeDoc() }).attach();
    root.dispatchEvent(fakeEvent("dblclick"));
    expect(root.querySelector("input")).toBeNull();
  });

  it("reports editing() true only while a line is open for correction", () => {
    const root = paneWithLine();
    const lineEdit = createLineEdit({ root, save: vi.fn(), setStatus: vi.fn(), doc: fakeDoc() });
    lineEdit.attach();
    expect(lineEdit.editing()).toBe(false);
    root.querySelector(".line").dispatchEvent(fakeEvent("dblclick"));
    expect(lineEdit.editing()).toBe(true);
    root.querySelector("input").dispatchEvent(fakeEvent("keydown", { key: "Escape" }));
    expect(lineEdit.editing()).toBe(false);
  });

  it("does not let a click on the input while editing reach a playback listener on root", () => {
    const root = paneWithLine();
    const outerClick = vi.fn();
    root.addEventListener("click", outerClick);
    createLineEdit({ root, save: vi.fn(), setStatus: vi.fn(), doc: fakeDoc() }).attach();
    root.querySelector(".line").dispatchEvent(fakeEvent("dblclick"));
    root.querySelector("input").dispatchEvent(fakeEvent("click"));
    expect(outerClick).not.toHaveBeenCalled();
  });

  it("stops the row looking playable while it is being edited, and restores it after", () => {
    const root = paneWithLine();
    const row = root.querySelector(".line");
    row.classList.add("line--playable");
    createLineEdit({ root, save: vi.fn(), setStatus: vi.fn(), doc: fakeDoc() }).attach();
    row.dispatchEvent(fakeEvent("dblclick"));
    expect(row.classList.contains("line--playable")).toBe(false);
    root.querySelector("input").dispatchEvent(fakeEvent("keydown", { key: "Escape" }));
    expect(row.classList.contains("line--playable")).toBe(true);
  });
});

// Important E from the whole-branch review. Both clicks of a double-click
// reach the click handler before lineEdit.editing() is ever true, so before
// this the first click started the chunk, the second toggled it off, and the
// pending play() rejected with an AbortError: "Could not play that chunk" on
// every single correction of a session that has audio.
describe("playing and correcting the same line", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The wiring app.js does: one delegated click handler through the
   *  activator, the dblclick opening a correction, and the correction
   *  cancelling both the pending play and anything already playing. */
  function wireTranscript({ recording = false } = {}) {
    vi.useFakeTimers();
    const root = paneWithLine();
    const row = root.querySelector(".line");
    row.classList.add("line--playable");

    const play = vi.fn();
    const stopPlayback = vi.fn();
    const setStatus = vi.fn();

    const activator = createLineActivator({ play, shouldDelay: () => !recording });
    const lineEdit = createLineEdit({
      root,
      save: vi.fn().mockResolvedValue({ line: { index: 0, text: "makes Raft tolerant" } }),
      setStatus,
      onEdit: () => {
        activator.cancel();
        stopPlayback();
      },
      doc: fakeDoc(),
    });
    lineEdit.attach();

    root.addEventListener("click", (event) => {
      if (lineEdit.editing()) return;
      const target = event.target.closest(".line--playable");
      if (!target) return;
      activator.activate(Number(target.dataset.index), event.shiftKey);
    });
    root.addEventListener("dblclick", () => activator.cancel());

    return { root, row, play, stopPlayback, setStatus };
  }

  it("does not play anything when a line is double-clicked to correct it", () => {
    const { root, row, play, stopPlayback, setStatus } = wireTranscript();

    row.dispatchEvent(fakeEvent("click"));
    row.dispatchEvent(fakeEvent("click"));
    row.dispatchEvent(fakeEvent("dblclick"));
    vi.advanceTimersByTime(1000);

    expect(play).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    // Entering a correction also stops whatever was already playing, so the
    // audio is not talking over the reader while they type.
    expect(stopPlayback).toHaveBeenCalled();
    expect(root.querySelector("input")).not.toBeNull();
  });

  it("still plays a single click, once the double-click window has passed", () => {
    const { row, play } = wireTranscript();

    row.dispatchEvent(fakeEvent("click", { shiftKey: false }));
    expect(play).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);

    expect(play).toHaveBeenCalledWith(0, false);
  });

  it("plays instantly while recording, where a double-click cannot mean editing", () => {
    const { row, play } = wireTranscript({ recording: true });

    row.dispatchEvent(fakeEvent("click", { shiftKey: true }));

    // No timer advanced: during a lecture the whole point is hearing the line
    // the moment you click it.
    expect(play).toHaveBeenCalledWith(0, true);
  });
});
