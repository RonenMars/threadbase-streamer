import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach } from "vitest";

/**
 * Give the whole suite its own scanner index.
 *
 * Without it, any test that builds a ConversationScanner without pinning
 * `persistent.dbPath` resolves it to the developer's real
 * `~/.config/threadbase-scanner/index.db` and indexes this repo's fixtures into
 * it. Measured on one machine before this existed: 579 of 1,144 rows in that
 * index were test fixtures, 357 of them ours — pointing at
 * `__tests__/fixtures/contract-projects/…` under various worktrees.
 *
 * Those rows are indistinguishable from real conversations in every coverage
 * query, so they silently corrupt any measurement taken of the index. They also
 * outlive the run, because a temp fixture directory vanishing just leaves the
 * row marked deleted rather than removing it.
 *
 * Scanner ≥0.14.6 throws when a test process reaches the default path, so this
 * file is what keeps the suite green against that guard rather than a
 * belt-and-braces nicety.
 *
 * Re-asserted in a beforeEach for the same reason as isolate-runtime-db: the
 * suite is single-fork and at least one test file swaps `process.env` for a
 * snapshot object wholesale, which drops a value set only once per file.
 */
const SCANNER_DB = join(mkdtempSync(join(tmpdir(), "tb-test-scanner-")), "index.db");

process.env.TB_SCANNER_DB = SCANNER_DB;
beforeEach(() => {
  process.env.TB_SCANNER_DB = SCANNER_DB;
});
