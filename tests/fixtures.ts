// Shared test fixtures for the Session test suite. Plain helper module, not a
// test file itself: tests/session.test.ts and tests/session-restore.test.ts
// both import from here, so there is exactly one definition of each fixture
// and no test file imports another test file (importing a *.test.ts file
// re-registers its describe()/it() blocks a second time under the importer).
import { vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";

export async function testConfig(overrides: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "scribe-sessions-"));
  return loadConfig({
    GROQ_API_KEY: "gsk_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    SCRIBE_SESSIONS_DIR: dir,
    SCRIBE_SUMMARY_INTERVAL_MINUTES: "5",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export const okDeps = () => ({
  transcribe: vi.fn().mockResolvedValue("hello world"),
  running: vi.fn().mockResolvedValue({
    topics: ["t"], keyPoints: [], definitions: [], flagged: [], openQuestions: [],
  }),
  final: vi.fn().mockResolvedValue("# Notes"),
});
