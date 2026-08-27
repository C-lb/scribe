import { describe, it, expect, vi } from "vitest";
import { createFlags } from "../src/web/flags.js";

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
