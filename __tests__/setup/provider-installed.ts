import { vi } from "vitest";

/**
 * Pretend both provider CLIs are on this machine.
 *
 * `LiveSessionManager.assertProviderInstalled` asks the real filesystem before
 * spawning, so without this every test that starts, resumes, adopts or forks a
 * session asserts what happens to be installed on the host: green on a
 * developer's laptop, red on a CI runner that has neither `claude` nor `codex`.
 * That is the same reason node-pty is mocked — the provider CLI is part of the
 * environment, not part of what these tests exercise.
 *
 * The path is deliberately fake. Nothing spawns it (node-pty is mocked), and a
 * version probe against it fails fast rather than shelling out to a real
 * binary, which keeps `/api/providers` cheap in the integration tests.
 *
 * A test that IS about the pre-flight overrides this with its own mock — see
 * __tests__/provider-not-installed.test.ts, which drives both answers.
 */
vi.mock("../../src/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/platform")>()),
  locateProviderExe: () => "/mock/bin/provider-cli",
}));
