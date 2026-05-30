import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { TASK_NAME } from "../src/lifecycle/constants";
import { clearMarker, readMarker } from "../src/lifecycle/marker";
import { getSupervisor } from "../src/lifecycle/platform";
import { isPidAlive } from "../src/lifecycle/process-liveness";
import { getLogger } from "../src/logger";

const log = getLogger("prod");

export type CommandResult = { ok: boolean; message: string };

export async function runProdStart(): Promise<CommandResult> {
  if (!getSupervisor().isAgentLoaded()) {
    const message =
      process.platform === "darwin"
        ? "launchd agent com.ronen.threadbase is not loaded. Run 'scripts/deploy.sh setup' to install it."
        : `task '${TASK_NAME}' is not registered. Run 'scripts\\deploy.ps1 setup' to install it.`;
    return { ok: false, message };
  }
  clearMarker();
  getSupervisor().kickstartAgent();
  const restoredMsg =
    process.platform === "darwin"
      ? "prod streamer restored — launchd is starting it now."
      : "prod streamer restored — Task Scheduler is starting it now.";
  return { ok: true, message: restoredMsg };
}

export async function runProdStop(): Promise<CommandResult> {
  getSupervisor().bootoutAgent();
  const what =
    process.platform === "darwin" ? "launchd agent unloaded" : "Task Scheduler task disabled";
  return {
    ok: true,
    message: `prod streamer stopped (${what}). It will not auto-restart until 'tb-streamer prod start' or system reboot.`,
  };
}

export type ProdStatus = {
  agentLoaded: boolean;
  agentPid: number | null;
  marker: ReturnType<typeof readMarker>;
};

export async function runProdStatus(): Promise<ProdStatus> {
  const sup = getSupervisor();
  return {
    agentLoaded: sup.isAgentLoaded(),
    agentPid: sup.getAgentPid(),
    marker: readMarker(),
  };
}

export type DoctorReport = { findings: string[]; repairs: string[] };

export async function runProdDoctor(opts: { fix: boolean }): Promise<DoctorReport> {
  const findings: string[] = [];
  const repairs: string[] = [];

  const marker = readMarker();
  if (marker && !marker.userHeld && !isPidAlive(marker.devPid)) {
    findings.push(`stale marker (dev pid ${marker.devPid} dead)`);
    if (opts.fix) {
      clearMarker();
      repairs.push(`cleared stale marker (dev pid ${marker.devPid} was dead)`);
    }
  }

  if (!getSupervisor().isAgentLoaded()) {
    findings.push("launchd agent is not loaded — prod is fully down");
  }

  return { findings, repairs };
}

export function registerProdCommands(program: Command): void {
  const prod = new CommanderCommand("prod").description(
    "Manage the launchd-supervised prod streamer",
  );

  prod
    .command("start")
    .description("Restore prod after a user-held suspension")
    .action(async () => {
      const r = await runProdStart();
      log.info(r.message, undefined, "console");
      if (!r.ok) process.exitCode = 1;
    });

  prod
    .command("stop")
    .description("Unload the launchd agent (prod will not auto-restart)")
    .action(async () => {
      const r = await runProdStop();
      log.info(r.message, undefined, "console");
    });

  prod
    .command("status")
    .description("Report whether prod is supervised, suspended, or down")
    .action(async () => {
      const s = await runProdStatus();
      const parts = [
        `agent: ${s.agentLoaded ? "loaded" : "NOT loaded"}`,
        `pid: ${s.agentPid ?? "(none)"}`,
        s.marker
          ? `marker: ${s.marker.userHeld ? "userHeld (intentional stop)" : "dev-suspended"}, ` +
            `devPid=${s.marker.devPid}, port=${s.marker.port}, repo=${s.marker.repoToplevel}`
          : "marker: none",
      ];
      log.info(parts.join("\n  "), undefined, "console");
    });

  prod
    .command("restart")
    .description("Stop + restart the supervised streamer (re-reads service definition)")
    .action(async () => {
      const sup = getSupervisor();
      sup.bootoutAgent();
      const specPath =
        process.platform === "darwin"
          ? `${process.env.HOME}/Library/LaunchAgents/com.ronen.threadbase.plist`
          : "";
      sup.bootstrapAgent(specPath);
      const what =
        process.platform === "darwin"
          ? `agent restarted from ${specPath}`
          : `task '${TASK_NAME}' restarted`;
      log.info(what, undefined, "console");
    });

  prod
    .command("doctor")
    .description("Detect & repair stale markers, missing agent, plist drift")
    .option("--fix", "Apply repairs (default is dry-run)", false)
    .action(async (opts) => {
      const r = await runProdDoctor({ fix: opts.fix === true });
      log.info(`findings: ${r.findings.length === 0 ? "(none)" : ""}`, undefined, "console");
      for (const f of r.findings) log.info(`  - ${f}`, undefined, "console");
      if (r.repairs.length) {
        log.info(`repairs:`, undefined, "console");
        for (const fix of r.repairs) log.info(`  - ${fix}`, undefined, "console");
      } else if (!opts.fix && r.findings.length > 0) {
        log.info(`(re-run with --fix to apply repairs)`, undefined, "console");
      }
    });

  program.addCommand(prod);
}
