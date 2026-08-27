import { describe, it, expect, vi } from "vitest";
import { createFlags, createFlagKey } from "../src/web/flags.js";

describe("createFlags", () => {
  it("posts the elapsed time when the key is pressed", async () => {
    const post = vi.fn().mockResolvedValue({ flag: { atMs: 5000, chunkIndex: 0 } });
    const flags = createFlags({ post, elapsedMs: () => 5000, setStatus: vi.fn() });
    await flags.mark();
    expect(post).toHaveBeenCalledWith(5000);
  });

  it("confirms in the status line, because a keypress with no response is a dead key", async () => {
    const setStatus = vi.fn();
    const flags = createFlags({
      post: vi.fn().mockResolvedValue({ flag: { atMs: 63_000, chunkIndex: 3 } }),
      elapsedMs: () => 63_000,
      setStatus,
    });
    await flags.mark();
    expect(setStatus).toHaveBeenCalledWith("Flagged at 01:03");
  });

  it("says so when the flag did not land", async () => {
    const setStatus = vi.fn();
    const flags = createFlags({
      post: vi.fn().mockRejectedValue(new Error("offline")),
      elapsedMs: () => 1000,
      setStatus,
    });
    await flags.mark();
    expect(setStatus).toHaveBeenCalledWith("Could not flag that moment: offline");
  });
});

// Fake DOM targets: `closest` behaves the way the real one would for the
// selector createFlagKey uses ("input, textarea, select, [contenteditable]"),
// without needing an actual DOM. A target inside a form control resolves to
// that control; anything else (the document body, a paragraph) resolves to
// null, the same as Element.closest() does for a selector that matches
// nothing between the target and the document root.
const insideSelect = { closest: (selector) => (selector.includes("select") ? { tagName: "SELECT" } : null) };
const plainBody = { closest: () => null };

function fakeEvent(overrides = {}) {
  return {
    key: "f",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    target: plainBody,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe("createFlagKey", () => {
  it("marks on a bare f keydown while recording, and suppresses the browser default", () => {
    const flags = { mark: vi.fn() };
    const handle = createFlagKey({ flags, isRecording: () => true });
    const event = fakeEvent();
    handle(event);
    expect(flags.mark).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  // This is the case the mic-select regression: #mic-select is never
  // disabled during a recording, so it stays a live keydown target the
  // whole time. Losing this guard means pressing f while it has focus both
  // eats the select's own type-ahead and drops an unintended flag.
  it("does not mark when the event target is inside a select", () => {
    const flags = { mark: vi.fn() };
    const handle = createFlagKey({ flags, isRecording: () => true });
    handle(fakeEvent({ target: insideSelect }));
    expect(flags.mark).not.toHaveBeenCalled();
  });

  it("marks a keydown whose target is the document body", () => {
    const flags = { mark: vi.fn() };
    const handle = createFlagKey({ flags, isRecording: () => true });
    handle(fakeEvent({ target: plainBody }));
    expect(flags.mark).toHaveBeenCalled();
  });

  it("does nothing while nothing is recording", () => {
    const flags = { mark: vi.fn() };
    const handle = createFlagKey({ flags, isRecording: () => false });
    handle(fakeEvent());
    expect(flags.mark).not.toHaveBeenCalled();
  });

  it("leaves a modified keypress alone, so Cmd/Ctrl+F still opens find", () => {
    const flags = { mark: vi.fn() };
    const handle = createFlagKey({ flags, isRecording: () => true });
    handle(fakeEvent({ metaKey: true }));
    expect(flags.mark).not.toHaveBeenCalled();
  });

  it("ignores keys other than f", () => {
    const flags = { mark: vi.fn() };
    const handle = createFlagKey({ flags, isRecording: () => true });
    handle(fakeEvent({ key: "g" }));
    expect(flags.mark).not.toHaveBeenCalled();
  });
});
