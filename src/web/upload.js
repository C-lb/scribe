/**
 * Uploads chunks one at a time with a bounded backlog.
 *
 * Nothing here is allowed to throw into the capture loop. If the server is
 * unreachable the queue grows to its cap, then sheds its oldest chunk — the
 * lecture keeps recording either way.
 */
export function createUploader({ sessionId, chunkSeconds = 20, maxQueueSeconds = 120, onStatus }) {
  const queue = [];
  const maxQueued = Math.max(1, Math.ceil(maxQueueSeconds / chunkSeconds));
  let running = false;
  let dropped = 0;

  function report() {
    if (onStatus) onStatus({ queued: queue.length, dropped });
  }

  async function pump() {
    if (running) return;
    running = true;
    while (queue.length > 0) {
      const chunk = queue[0];
      try {
        const response = await fetch(`/api/sessions/${sessionId}/chunk`, {
          method: "POST",
          headers: {
            "Content-Type": "audio/wav",
            "X-Chunk-Index": String(chunk.index),
            "X-Chunk-Start-Ms": String(Math.round(chunk.startMs)),
            "X-Chunk-End-Ms": String(Math.round(chunk.endMs)),
          },
          body: chunk.wav,
        });
        if (!response.ok) throw new Error(`upload failed: ${response.status}`);
        queue.shift();
      } catch (error) {
        console.warn("[scribe] chunk upload failed, will retry", error);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      report();
    }
    running = false;
  }

  return {
    enqueue(chunk) {
      queue.push(chunk);
      while (queue.length > maxQueued) {
        queue.shift();
        dropped += 1;
      }
      report();
      void pump();
    },
    /**
     * Wait for the backlog to clear, but never indefinitely. A stop button that
     * hangs costs the whole lecture's final summary; abandoning a couple of
     * unsent chunks costs a few seconds of transcript whose audio is already
     * safely on disk.
     */
    async drain(timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (queue.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return { unsent: queue.length };
    },
  };
}
