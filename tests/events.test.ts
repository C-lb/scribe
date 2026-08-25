import { describe, it, expect, vi } from "vitest";
import { EventBroker } from "../src/server/events.js";

const status = { type: "status", failedChunks: 0, silenceArtefacts: 0, audioSeconds: 0, estimatedCostUsd: 0 } as const;

describe("EventBroker", () => {
  it("delivers published events to subscribers", () => {
    const broker = new EventBroker();
    const listener = vi.fn();
    broker.subscribe(listener);
    broker.publish(status);
    expect(listener).toHaveBeenCalledWith(status);
  });

  it("stops delivering after unsubscribe", () => {
    const broker = new EventBroker();
    const listener = vi.fn();
    const unsubscribe = broker.subscribe(listener);
    unsubscribe();
    broker.publish(status);
    expect(listener).not.toHaveBeenCalled();
  });

  it("replays past events to a late subscriber", () => {
    const broker = new EventBroker();
    broker.publish(status);
    const listener = vi.fn();
    broker.replay(listener);
    expect(listener).toHaveBeenCalledWith(status);
  });

  it("keeps one listener's failure from blocking the others", () => {
    const broker = new EventBroker();
    const good = vi.fn();
    broker.subscribe(() => { throw new Error("listener blew up"); });
    broker.subscribe(good);
    expect(() => broker.publish(status)).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});
