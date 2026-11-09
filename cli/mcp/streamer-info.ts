import { type StreamerTool, textResult } from "./client";

interface InfoResponse {
  version: string;
}

interface ProvidersResponse {
  providers: Array<{ name: string; available: boolean; version: string | null }>;
}

// No `updateAvailable`: no streamer route exposes it yet (`GET /api/info` has
// no such field), and #1176 forbids the shim inventing logic the REST API lacks.
export const streamerInfoTools: StreamerTool[] = [
  {
    name: "streamer_info",
    description:
      "Version and providers of the Threadbase streamer on this machine. " +
      "Each provider (claude-code, codex-cli, cursor, copilot) carries `available` (its CLI is installed) and `version`. " +
      "Fails with a one-line error when the streamer is not running or the API key is missing or rejected.",
    inputSchema: {},
    handler: async (_args, client) => {
      const [info, providers] = await Promise.all([
        client.get<InfoResponse>("/api/info"),
        client.get<ProvidersResponse>("/api/providers"),
      ]);
      return textResult({
        reachable: true,
        version: info.version,
        providers: providers.providers.map(({ name, available, version }) => ({
          name,
          available,
          version,
        })),
      });
    },
  },
];
