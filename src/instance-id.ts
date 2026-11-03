import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir, hostname } from "os";
import { join } from "path";
import { getLogger } from "./logger";

/**
 * `~/.threadbase/instance-id`. Resolved per call, inlined like the other
 * config-dir files — tests redirect it with THREADBASE_CONFIG_DIR.
 */
export function instanceIdPath(): string {
  return join(process.env.THREADBASE_CONFIG_DIR ?? join(homedir(), ".threadbase"), "instance-id");
}

let warned = false;
/** Test hook: the unwritable-dir warning is logged once per process. */
export function resetInstanceIdWarning(): void {
  warned = false;
}

function readStored(): string | null {
  try {
    return readFileSync(instanceIdPath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * The one identity of this streamer, used as DB session scope, the Live
 * Activity `serverId` and the pty-host socket name. Every reader goes through
 * here, so they cannot disagree.
 *
 * 1. `THREADBASE_INSTANCE_ID`, when non-empty. Never persisted.
 * 2. The persisted file.
 * 3. First boot: seed the file with what every reader returned before this
 *    file existed (`os.hostname()`), so paired clients and a pty-host already
 *    running under that name keep matching, and a later rename changes nothing.
 *    A blank hostname gets a random id instead.
 *
 * Never throws: an unwritable config dir returns the in-memory value and warns
 * once. The create is exclusive (`wx`), so a streamer and a CLI command racing
 * on first boot end with one file, and the loser adopts the winner's value.
 */
export function getInstanceId(): string {
  const fromEnv = process.env.THREADBASE_INSTANCE_ID;
  if (fromEnv) return fromEnv;

  const stored = readStored();
  if (stored) return stored;

  const seed = hostname() || randomUUID();
  try {
    mkdirSync(join(instanceIdPath(), ".."), { recursive: true });
    writeFileSync(instanceIdPath(), seed, { flag: "wx" });
  } catch (err) {
    // ponytail: a reader can see the winner's file between its create and its
    // write (empty) and fall back to its own seed; the window is microseconds.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return readStored() ?? seed;
    if (!warned) {
      warned = true;
      getLogger("instance-id").warn(
        `Could not persist the instance id at ${instanceIdPath()}; using "${seed}" for this run: ${String(err)}`,
        { event: "instance_id.persist_failed" },
      );
    }
  }
  return seed;
}
