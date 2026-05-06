import type { ServerResponse } from "http";
import { ListProjectChatsQuerySchema } from "../schemas/queryParams.schema";
import type { ListProjectChatsDeps } from "../services/projectChats/listProjectChats";
import { listProjectChats } from "../services/projectChats/listProjectChats";

/**
 * GET /project-chats
 *
 * Returns the unified active-sessions + historical-conversations list.
 *
 *   ?refreshConversations=1 → force a full conversation/projects refresh
 *   ?refresh=1              → legacy alias, same effect
 */
export function handleListProjectChats(
  url: URL,
  res: ServerResponse,
  deps: ListProjectChatsDeps,
): void {
  const queryObj = Object.fromEntries(url.searchParams.entries());
  const parsed = ListProjectChatsQuerySchema.safeParse(queryObj);

  if (!parsed.success) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Invalid query parameters",
        details: parsed.error.flatten(),
      }),
    );
    return;
  }

  const refreshConversations =
    parsed.data.refreshConversations === "1" || parsed.data.refresh === "1";

  const chats = listProjectChats(deps, { refreshConversations });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ projectChats: chats }));
}
