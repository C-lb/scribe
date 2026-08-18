import { describe, it, expect, vi } from "vitest";
import { withRetry, RetryableError } from "../src/server/retry.js";

const noSleep = async () => {};

describe("withRetry", () => {
  it("returns the first successful result without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn, { sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable failure and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("503"))
      .mockResolvedValue("ok");
    expect(await withRetry(fn, { sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured number of attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError("503"));
    await expect(withRetry(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow("503");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("400 bad request"));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow("400 bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new RetryableError("503"));
    await expect(
      withRetry(fn, {
        attempts: 3,
        baseDelayMs: 100,
        sleep: async (ms) => { delays.push(ms); },
      }),
    ).rejects.toThrow();
    expect(delays).toEqual([100, 200]);
  });

  it("honours an explicit retry-after over the backoff schedule", async () => {
    const delays: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("429", 5000))
      .mockResolvedValue("ok");
    await withRetry(fn, {
      baseDelayMs: 100,
      sleep: async (ms) => { delays.push(ms); },
    });
    expect(delays).toEqual([5000]);
  });
});
