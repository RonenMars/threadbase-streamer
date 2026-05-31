import { setApiKey } from "../src/auth";

const KEY_PATTERN = /^tb_[a-f0-9]{32}$/;

export interface SetKeyArgs {
  key: string | undefined;
}

export interface SetKeyDeps {
  log: { info: (msg: string) => void; error: (msg: string) => void };
  readStdin?: () => Promise<string>;
}

async function defaultReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

export async function runSetKey(args: SetKeyArgs, deps: SetKeyDeps): Promise<number> {
  const readStdin = deps.readStdin ?? defaultReadStdin;

  let key = args.key;
  if (key === "-") {
    key = (await readStdin()).trim();
  }

  if (!key || key.length === 0) {
    deps.log.error("API key required. Pass as argument or via stdin with '-'.");
    return 1;
  }

  if (!KEY_PATTERN.test(key)) {
    deps.log.error("Invalid key format. Expected: tb_<32 hex chars>");
    return 1;
  }

  try {
    setApiKey(key);
  } catch (err) {
    deps.log.error(`Failed to write key: ${(err as Error).message}`);
    return 1;
  }

  deps.log.info("API key updated.");
  deps.log.info("Restart the service to pick up the new key: brew services restart tb-streamer");
  return 0;
}
