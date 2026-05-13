import { Hono } from "hono";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

// Sentinel status used to signal that the handler already wrote to the Node
// ServerResponse directly. writeHonoResponse in server.ts skips piping when
// it sees this status.
export const ALREADY_HANDLED = 597;
const alreadyHandled = () => new Response(null, { status: ALREADY_HANDLED });

export const createSessionRoutes = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>();

  app.get("/count", (c) => {
    deps.handleSessionsCount(c.env.outgoing);
    return alreadyHandled();
  });

  app.get("/recents", (c) => {
    const url = new URL(c.req.url);
    deps.handleGetRecentSessions(url, c.env.outgoing);
    return alreadyHandled();
  });

  app.get("/names", (c) => {
    deps.handleGetSessionNames(c.env.outgoing);
    return alreadyHandled();
  });

  app.post("/resume", async (c) => {
    await deps.handleResume(c.env.incoming, c.env.outgoing);
    return alreadyHandled();
  });

  app.post("/start", async (c) => {
    await deps.handleStartSession(c.env.incoming, c.env.outgoing);
    return alreadyHandled();
  });

  app.get("/", async (c) => {
    const url = new URL(c.req.url);
    await deps.handleListSessions(url, c.env.outgoing);
    return alreadyHandled();
  });

  app.get("/:id/output", (c) => {
    deps.handleGetOutput(c.req.param("id"), c.env.outgoing);
    return alreadyHandled();
  });

  app.post("/:id/input", async (c) => {
    await deps.handleSendInput(c.req.param("id"), c.env.incoming, c.env.outgoing);
    return alreadyHandled();
  });

  app.post("/:id/files", async (c) => {
    await deps.handleUploadFile(c.req.param("id"), c.env.incoming, c.env.outgoing);
    return alreadyHandled();
  });

  app.post("/:id/cancel", (c) => {
    deps.handleCancel(c.req.param("id"), c.env.outgoing);
    return alreadyHandled();
  });

  app.patch("/:id/name", async (c) => {
    await deps.handleSetSessionName(c.req.param("id"), c.env.incoming, c.env.outgoing);
    return alreadyHandled();
  });

  app.post("/:id/adopt", async (c) => {
    await deps.handleAdopt(c.req.param("id"), c.env.outgoing);
    return alreadyHandled();
  });

  app.get("/:id", (c) => {
    deps.handleGetSession(c.req.param("id"), c.env.outgoing);
    return alreadyHandled();
  });

  return app;
};
