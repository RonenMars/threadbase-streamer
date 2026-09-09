import { createJsonlParseState, parseCodexJsonlLine, parseJsonlLine } from "@threadbase-sh/scanner";
import { closeSync, openSync, readSync } from "fs";
import { StringDecoder } from "string_decoder";
import { z } from "zod";
import { isCodexInjectedContext } from "../../utils/codexConversationLine";

const identityRecord = z.object({
  type: z.string().optional(),
  isSidechain: z.boolean().optional(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  payload: z
    .object({
      id: z.string().optional(),
      source: z.unknown().optional(),
    })
    .passthrough()
    .optional(),
});
const spawnSource = z.object({
  subagent: z.object({
    thread_spawn: z.object({ parent_thread_id: z.string().min(1) }),
  }),
});

export class ConversationClassifier {
  readonly state = createJsonlParseState();
  hasMessages = false;
  isSubagent = false;
  parentConversationId: string | null = null;
  id: string;
  provider: "claude-code" | "codex-cli";
  private explicitClaudeIdentity = false;
  private sawIdentity = false;
  private readonly fileStem: string;

  /**
   * Nothing later in the file can change the answer: `hasMessages` only ever
   * goes false→true, and identity settles at Codex's line-0 `session_meta` or
   * the first Claude line carrying `isSidechain`. A file with no renderable
   * message is never settled and is read in full — that is how `hasMessages`
   * earns a definitive 0, and such files are small.
   */
  get settled(): boolean {
    return this.hasMessages && this.sawIdentity;
  }

  constructor(filePath: string, provider: "claude-code" | "codex-cli" = "claude-code") {
    this.id =
      filePath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.jsonl$/, "") ?? filePath;
    this.fileStem = this.id;
    this.provider = provider;
    this.isSubagent = /[/\\]subagents[/\\]agent-[^/\\]+\.jsonl$/.test(filePath);
  }

  append(raw: string) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const parsed = identityRecord.safeParse(value);
    if (parsed.success) {
      const entry = parsed.data;
      if (entry.type === "session_meta" && entry.payload) {
        this.provider = "codex-cli";
        this.sawIdentity = true;
        if (entry.payload.id) this.id = entry.payload.id;
        // A `subagent` key is what makes it provider-created; the value varies
        // ("review", {other:…}, {thread_spawn:…}) and only thread_spawn names a
        // parent. Keying on the full thread_spawn shape classified the other
        // values as ordinary top-level history and showed them to the user.
        // A string source ("cli", "vscode", "exec", …) is never a subagent.
        const source = entry.payload.source;
        this.isSubagent = typeof source === "object" && source !== null && "subagent" in source;
        const spawn = spawnSource.safeParse(source);
        this.parentConversationId = spawn.success
          ? spawn.data.subagent.thread_spawn.parent_thread_id
          : null;
      } else if (this.provider === "claude-code" && entry.isSidechain !== undefined) {
        this.sawIdentity = true;
        if (entry.isSidechain === true && entry.agentId?.trim()) {
          this.explicitClaudeIdentity = true;
          this.id = this.fileStem;
          this.isSubagent = true;
          this.parentConversationId = entry.sessionId || null;
        } else if (!this.explicitClaudeIdentity) {
          this.isSubagent = false;
        }
      }
    }
    const message =
      this.provider === "codex-cli" ? parseCodexJsonlLine(raw) : parseJsonlLine(raw, this.state);
    if (message?.role === "user" && isCodexInjectedContext(message.text ?? "")) return null;
    if (message) this.hasMessages = true;
    return message;
  }
}

/** Bounded memory, using exactly the adapters used by conversation detail. */
export function classifyConversationFile(filePath: string, provider?: "claude-code" | "codex-cli") {
  const classifier = new ConversationClassifier(filePath, provider);
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    for (;;) {
      const length = readSync(fd, buffer, 0, buffer.length, null);
      if (length === 0) break;
      pending += decoder.write(buffer.subarray(0, length));
      let end = pending.indexOf("\n");
      while (end >= 0) {
        classifier.append(pending.slice(0, end));
        pending = pending.slice(end + 1);
        end = pending.indexOf("\n");
      }
      // Every scan reads every transcript on the box, so stopping at the first
      // line that settles both facts is the difference between reading a few
      // hundred bytes and reading the whole corpus.
      if (classifier.settled) return classifier;
    }
    pending += decoder.end();
    if (pending.trim()) classifier.append(pending);
    return classifier;
  } finally {
    closeSync(fd);
  }
}
