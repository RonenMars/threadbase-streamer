import type { Logger } from "../src/logger";

/**
 * The boot line naming the key the server came up with.
 *
 * Only the masked form may reach a log sink. Interpolating the whole key here
 * wrote a credential equivalent to a shell on the machine into the JSON log
 * people attach to bug reports (#723); the structured `apiKeyMasked` field
 * beside it had always masked, and the message string was what leaked.
 *
 * Nothing needs the plaintext at boot. Contrary to the issue's reading,
 * `printServerBanner` does not print the key: the pairing banner carries a
 * short-lived `pt_` pair token and uses the key only as a Bearer header, so
 * masking here removes the last plaintext copy from a boot artefact rather
 * than duplicating something the terminal already shows. An operator who
 * wants the key reads `~/.threadbase/server.yaml`.
 *
 * It lives in its own module so a test can drive the real logger and read the
 * bytes it emits; `cli/index.ts` runs `program.parse()` on import and cannot
 * be loaded from a test.
 */
export function logApiKeyLine(log: Logger, apiKey: string): void {
  const apiKeyMasked = `${apiKey.slice(0, 6)}…`;
  log.info(`API key: ${apiKeyMasked}`, { apiKeyMasked });
}
