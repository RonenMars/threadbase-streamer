import type { ErrorHandler } from "hono";
import type { AppEnv } from "../app";

export const errorMiddleware: ErrorHandler<AppEnv> = (err, c) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  return c.json({ error: message }, 500);
};
