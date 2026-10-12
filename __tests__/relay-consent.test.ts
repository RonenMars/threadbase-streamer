import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFeatureFlags, loadRelayConsent, setRelayConsent, setRelayEnabled } from "../src/auth";
import { decideRelay, type RelayConsentDeps } from "../src/relay/consent";

const ENDPOINT = "wss://relay.example/tunnel";

function run(
  over: Partial<RelayConsentDeps>,
  answers: { first?: boolean; confirm?: boolean } = {},
) {
  const calls: string[] = [];
  const deps: RelayConsentDeps = {
    enabled: false,
    source: "default",
    endpoint: ENDPOINT,
    consent: undefined,
    interactive: true,
    askFirstRun: async () => (calls.push("askFirstRun"), answers.first ?? false),
    confirmEnabled: async () => (calls.push("confirmEnabled"), answers.confirm ?? false),
    approve: () => void calls.push("approve"),
    decline: () => void calls.push("decline"),
    clearConsent: () => void calls.push("clearConsent"),
    warn: () => void calls.push("warn"),
    ...over,
  };
  return decideRelay(deps).then((on) => ({ on, calls }));
}

describe("decideRelay", () => {
  it("first run, asked yes: approves and runs", async () => {
    expect(await run({}, { first: true })).toEqual({ on: true, calls: ["askFirstRun", "approve"] });
  });

  it("first run, asked no: declines so it is never asked again", async () => {
    expect(await run({}, { first: false })).toEqual({
      on: false,
      calls: ["askFirstRun", "decline"],
    });
  });

  it("first run with no terminal: off, nothing asked", async () => {
    expect(await run({ interactive: false })).toEqual({ on: false, calls: [] });
  });

  it("an explicit off is an answer, not a first run", async () => {
    expect((await run({ source: "yaml" })).calls).toEqual([]);
    expect((await run({ source: "env" })).calls).toEqual([]);
  });

  it("a hand-disabled relay forgets the yes, so re-enabling asks again", async () => {
    expect(await run({ source: "yaml", consent: ENDPOINT })).toEqual({
      on: false,
      calls: ["clearConsent"],
    });
  });

  it("enabled with a recorded yes for this endpoint: runs without asking", async () => {
    expect(await run({ enabled: true, source: "env", consent: ENDPOINT })).toEqual({
      on: true,
      calls: [],
    });
  });

  it.each(["env", "cli", "yaml"] as const)(
    "enabled by %s without a yes: asks, and 'with' approves",
    async (source) => {
      expect(await run({ enabled: true, source }, { confirm: true })).toEqual({
        on: true,
        calls: ["confirmEnabled", "approve"],
      });
    },
  );

  it("enabled without a yes, answered 'without': declines and runs without", async () => {
    expect(await run({ enabled: true, source: "env" }, { confirm: false })).toEqual({
      on: false,
      calls: ["confirmEnabled", "decline"],
    });
  });

  it("a yes for another endpoint is not a yes for this one", async () => {
    const r = await run(
      { enabled: true, source: "yaml", consent: "wss://other/tunnel" },
      { confirm: false },
    );
    expect(r).toEqual({ on: false, calls: ["confirmEnabled", "decline"] });
  });

  it("enabled without a yes and no terminal: fails closed with a warning", async () => {
    expect(await run({ enabled: true, source: "env", interactive: false })).toEqual({
      on: false,
      calls: ["warn"],
    });
  });
});

describe("relay config writers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-relay-consent-"));
    vi.stubEnv("THREADBASE_CONFIG_DIR", dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("enable then disable round-trips and keeps the other flags", () => {
    writeFileSync(join(dir, "server.yaml"), 'api_key: tb_x\nfeature_flags: {"e2ee":true}\n');

    setRelayEnabled(true);
    setRelayConsent(ENDPOINT);
    expect(loadFeatureFlags()).toEqual({ e2ee: true, relay: true });
    expect(loadRelayConsent()).toBe(ENDPOINT);

    setRelayEnabled(false);
    setRelayConsent(undefined);
    expect(loadFeatureFlags()).toEqual({ e2ee: true, relay: false });
    expect(loadRelayConsent()).toBeUndefined();
    expect(readFileSync(join(dir, "server.yaml"), "utf-8")).toContain("api_key: tb_x");
  });
});
