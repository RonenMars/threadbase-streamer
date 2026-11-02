import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getLogger } from "../../logger";
import type { AppEnv } from "../app";

const log = getLogger("http");

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
  // Only a 500 is "unhandled": an error that names its own 4xx/5xx status was
  // thrown on purpose and the client already gets its reason. The path is
  // `c.req.path` (no query string, which can carry `?key=`); no headers or
  // body are read.
  if (status === 500) {
    log.error("[http] unhandled error", {
      event: "http.unhandled_error",
      path: c.req.path,
      method: c.req.method,
      err: { message, stack: err instanceof Error ? err.stack : undefined },
    });
  }
  return c.json(typeof code === "string" ? { error: message, code } : { error: message }, status);
};
