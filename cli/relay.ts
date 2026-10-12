import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import {
  loadFeatureFlags,
  loadRelayPublicKey,
  loadRelayUrl,
  setRelayConsent,
  setRelayEnabled,
} from "../src/auth";
import { resolveFeatureFlags } from "../src/feature-flags";
import { relayExplanation } from "../src/lifecycle/prompt";
import { getLogger } from "../src/logger";
import { relaySettings } from "../src/relay/hosted";

const log = getLogger("relay");
const say = (message: string) => log.info(message, undefined, "console");

/** The env var outranks server.yaml, so say so when it would undo what was just written. */
function noteEnvOverride(wanted: boolean) {
  const { values, sources } = resolveFeatureFlags({ yaml: loadFeatureFlags() });
  if (sources.relay === "env" && values.relay !== wanted) {
    say(
      `Note: THREADBASE_FEATURE_RELAY is set in this environment and overrides server.yaml, so the relay stays ${values.relay ? "on" : "off"} wherever it is set.`,
    );
  }
}

export function registerRelayCommands(program: Command): void {
  const relay = new CommanderCommand("relay").description("Turn the Threadbase relay on or off");

  relay
    .command("enable")
    .description("Use the relay for access from outside your network")
    .action(() => {
      const { relayUrl } = relaySettings(loadRelayUrl(), loadRelayPublicKey());
      if (!relayUrl) {
        say(
          "relay_public_key is set in server.yaml without relay_url; set both to use your own relay.",
        );
        process.exitCode = 1;
        return;
      }
      say(`The relay:\n${relayExplanation(relayUrl)}`);
      setRelayEnabled(true);
      setRelayConsent(relayUrl);
      say("Relay enabled. Restart the streamer to apply it: tb-streamer service restart");
      noteEnvOverride(true);
    });

  relay
    .command("disable")
    .description("Stop using the relay")
    .action(() => {
      setRelayEnabled(false);
      setRelayConsent(undefined);
      say("Relay disabled. Restart the streamer to apply it: tb-streamer service restart");
      noteEnvOverride(false);
    });

  program.addCommand(relay);
}
