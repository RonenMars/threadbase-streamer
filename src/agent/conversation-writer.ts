// src/agent/conversation-writer.ts
//
// Persists assistant turns to JSONL when the worker's final agent_output for a
// turn arrives. The existing ConversationCache + ConversationWatcher then
// ingest the line via the existing watcher pipeline — see spec §6.3.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AppendArgs {
	sessionId: string;
	turnId: string;
	content: string;
	reviewerOverruled?: boolean;
}

export interface ConversationWriter {
	appendAssistantTurn(args: AppendArgs): Promise<void>;
}

export function createConversationWriter(opts: {
	baseDir: string;
}): ConversationWriter {
	const { baseDir } = opts;

	return {
		async appendAssistantTurn(args: AppendArgs): Promise<void> {
			if (!args.content || args.content.length === 0) {
				throw new Error(
					"ConversationWriter: refusing to write empty assistant turn",
				);
			}
			const file = join(baseDir, `${args.sessionId}.jsonl`);
			await mkdir(dirname(file), { recursive: true });

			const record = {
				role: "assistant" as const,
				turnId: args.turnId,
				content: args.content,
				timestamp: Date.now(),
				...(args.reviewerOverruled ? { reviewerOverruled: true } : {}),
			};

			const line = `${JSON.stringify(record)}\n`;
			await appendFile(file, line, { encoding: "utf8" });
		},
	};
}
