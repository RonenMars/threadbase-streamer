import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app";

export const errorMiddleware: ErrorHandler<AppEnv> = (err, c) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  // Honour the { statusCode, code } convention the session paths already throw
  // with (LiveSessionManager). Handlers that catch locally never reach here —
  // start and fork do — but resume and adopt do not, so a refusal they raise
  // deliberately used to arrive as a bare 500 carrying nothing to branch on.
  // Bounded to real HTTP codes because `statusCode` is also a property some
  // libraries hang on their own errors, and one of those bubbling up must not
  // get to choose the response.
  const { statusCode, code } = err as Error & { statusCode?: unknown; code?: unknown };
  const status: ContentfulStatusCode =
    typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599
      ? (statusCode as ContentfulStatusCode)
      : 500;
  return c.json(typeof code === "string" ? { error: message, code } : { error: message }, status);
};
