import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/index.js";
import { loadConfig } from "../src/server/config.js";

/**
 * The browser loads app.js as an ES module, and a single 404 anywhere in that
 * import graph fails the WHOLE graph: no module in it evaluates, so not one
 * listener is ever attached and every button on the page goes dead in silence.
 *
 * This is invisible to `tsc` and to `node --check`, both of which resolve
 * imports on the filesystem. The browser resolves them against the static
 * root instead, so a web module reaching outside src/web -- as summary-export.js
 * once did, with `../shared/filename.js` -- exists on disk and 404s over HTTP.
 * Only a real request can tell the two apart, which is why this test walks the
 * graph the way the browser does rather than the way the compiler does.
 */

async function app() {
  const dir = await mkdtemp(path.join(tmpdir(), "scribe-graph-"));
  const config = loadConfig({
    GROQ_API_KEY: "gsk_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    SCRIBE_SESSIONS_DIR: dir,
  } as NodeJS.ProcessEnv);

  const deps = {
    transcribe: vi.fn().mockResolvedValue(""),
    running: vi.fn().mockResolvedValue({
      topics: [], keyPoints: [], definitions: [], flagged: [], openQuestions: [],
    }),
    final: vi.fn().mockResolvedValue(""),
  };

  const server = createApp(config, deps).listen(0);
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, server };
}

/** Every static import/export specifier, plus the worklet the recorder adds by
 *  URL -- addModule() is a module load too, and a 404 there breaks recording
 *  just as completely, only later and only once the user presses record. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|\s)import\s+[^"';]*?from\s*["']([^"']+)["']/g,
    /(?:^|\s)import\s*["']([^"']+)["']/g,
    /(?:^|\s)export\s+[^"';]*?from\s*["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /addModule\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) found.push(m[1]);
  }
  return found;
}

describe("browser module graph", () => {
  it("serves every module reachable from app.js", async () => {
    const { base, server } = await app();
    try {
      const seen = new Set<string>();
      const failures: string[] = [];
      const queue = ["/app.js"];

      while (queue.length > 0) {
        const url = queue.shift()!;
        if (seen.has(url)) continue;
        seen.add(url);

        const res = await fetch(`${base}${url}`);
        if (!res.ok) {
          failures.push(`${url} -> ${res.status}`);
          continue;
        }

        const source = await res.text();
        for (const spec of specifiers(source)) {
          // Bare specifiers would need an import map; this app ships none, so
          // anything that is not a path is already a bug of a different kind.
          if (!spec.startsWith(".") && !spec.startsWith("/")) {
            failures.push(`${url} imports bare specifier "${spec}"`);
            continue;
          }
          queue.push(new URL(spec, `${base}${url}`).pathname);
        }
      }

      expect(failures).toEqual([]);
      // Guard the guard: if the walk ever stops finding modules, this test
      // would pass while checking nothing at all.
      expect(seen.size).toBeGreaterThan(5);
    } finally {
      server.close();
    }
  });
});
