// Side-effect import: must stay right after `dotenv/config` and before every other
// import in cli/index.ts, so install-dir config is in process.env before anything
// reads APNS_*. launchd gets this from its shim; systemd and Task Scheduler run
// cli.js directly and only get it here.
import { loadInstallConfigIntoEnv } from "../src/config/install-env";

loadInstallConfigIntoEnv();
