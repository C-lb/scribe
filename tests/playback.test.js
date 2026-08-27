import { describe, it, expect, vi } from "vitest";
import { createPlayback } from "../src/web/playback.js";

const fakeAudio = () => ({
  src: "", currentTime: 0, paused: true,
  play: vi.fn(function () { this.paused = false; return Promise.resolve(); }),
  pause: vi.fn(function () { this.paused = true; }),
  addEventListener: vi.fn(),
});

describe("createPlayback", () => {
  it("points the element at the clicked line's chunk", async () => {
    const audioEl = fakeAudio();
    const playback = createPlayback({ audioEl, onState: () => {} });
    await playback.playLine("2026-08-27-10-00-00", { index: 3 }, { continuous: false });
    expect(audioEl.src).toBe("/api/sessions/2026-08-27-10-00-00/audio/3");
    expect(audioEl.play).toHaveBeenCalled();
  });

  it("reports the playing line so the row can show it", async () => {
    const onState = vi.fn();
    const playback = createPlayback({ audioEl: fakeAudio(), onState });
    await playback.playLine("s", { index: 3 }, { continuous: false });
    expect(onState).toHaveBeenCalledWith({ playingIndex: 3, continuous: false });
  });

  it("clicking the playing line stops it", async () => {
    const audioEl = fakeAudio();
    const onState = vi.fn();
    const playback = createPlayback({ audioEl, onState });
    await playback.playLine("s", { index: 3 }, { continuous: false });
    await playback.playLine("s", { index: 3 }, { continuous: false });
    expect(audioEl.pause).toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith({ playingIndex: null, continuous: false });
  });

  it("in continuous mode, ending a chunk advances to the next line", async () => {
    const audioEl = fakeAudio();
    const playback = createPlayback({ audioEl, onState: () => {} });
    playback.setLines([{ index: 0 }, { index: 2 }, { index: 3 }]);
    await playback.playLine("s", { index: 0 }, { continuous: true });
    const ended = audioEl.addEventListener.mock.calls.find(([name]) => name === "ended")[1];
    await ended();
    // index 1 was dropped as a silence artefact, so the next line is 2, not 1.
    expect(audioEl.src).toBe("/api/sessions/s/audio/2");
  });

  it("stop() pauses the element and clears state", async () => {
    const audioEl = fakeAudio();
    const onState = vi.fn();
    const playback = createPlayback({ audioEl, onState });
    await playback.playLine("s", { index: 0 }, { continuous: false });
    playback.stop();
    expect(audioEl.pause).toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith({ playingIndex: null, continuous: false });
    expect(playback.state()).toEqual({ playingIndex: null, continuous: false });
  });

  it("ending the last line in continuous mode stops rather than throwing", async () => {
    const audioEl = fakeAudio();
    const onState = vi.fn();
    const playback = createPlayback({ audioEl, onState });
    playback.setLines([{ index: 0 }, { index: 2 }]);
    await playback.playLine("s", { index: 2 }, { continuous: true });
    const ended = audioEl.addEventListener.mock.calls.find(([name]) => name === "ended")[1];
    await ended();
    expect(onState).toHaveBeenLastCalledWith({ playingIndex: null, continuous: false });
  });
});
