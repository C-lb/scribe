import type { TranscriptLine } from "./transcript.js";
import type { RunningSummary } from "./claude.js";

export type ScribeEvent =
  | { type: "transcript"; line: TranscriptLine }
  | { type: "summary"; summary: RunningSummary }
  | { type: "status"; failedChunks: number; audioSeconds: number; estimatedCostUsd: number }
  | { type: "final"; markdown: string };

export class EventBroker {
  private listeners = new Set<(event: ScribeEvent) => void>();
  private history: ScribeEvent[] = [];

  subscribe(listener: (event: ScribeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ScribeEvent): void {
    this.history.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // A dead SSE connection must not stop the pipeline or the other tabs.
        console.error("[scribe] event listener failed:", error);
      }
    }
  }

  replay(listener: (event: ScribeEvent) => void): void {
    for (const event of this.history) {
      try {
        listener(event);
      } catch (error) {
        console.error("[scribe] replay to listener failed:", error);
      }
    }
  }
}
