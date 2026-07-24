import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { classifyCodexLine } from "../src/utils/codexConversationLine";

/**
 * Versioned provider fixtures (C2).
 * See docs/architecture/2026-07-24-provider-compatibility.md.
 *
 * Fixtures used to be flat files with no recorded provenance, so a passing
 * suite proved only "we still parse the shape we captured at an unknown point
 * in the past". These tests make the provider version a first-class, asserted
 * fact: each fixture directory is named for the provider version it was
 * captured from, and that version is checked against the metadata the capture
 * carries in its own payload.
 *
 * Adding support for a new provider version means adding a directory — not
 * editing a parser.
 */

const ROOT = join(__dirname, "fixtures", "providers");

interface Manifest {
  provider: string;
  providerVersion: string;
  capturedAt: string;
  sanitized: boolean;
  envelopeTypes: string[];
}

function versionDirs(provider: string): string[] {
  return readdirSync(join(ROOT, provider)).filter((d) =>
    statSync(join(ROOT, provider, d)).isDirectory(),
  );
}

function readManifest(provider: string, version: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, provider, version, "manifest.json"), "utf8"));
}

function readLines(provider: string, version: string, file: string): string[] {
  return readFileSync(join(ROOT, provider, version, file), "utf8")
    .split("\n")
    .filter(Boolean);
}

describe("versioned provider fixtures", () => {
  const providers = readdirSync(ROOT).filter((d) => statSync(join(ROOT, d)).isDirectory());

  it("has at least one versioned fixture per supported provider", () => {
    expect(providers.sort()).toEqual(["claude-code", "codex-cli"]);
    for (const p of providers) expect(versionDirs(p).length).toBeGreaterThan(0);
  });

  describe.each(providers)("%s", (provider) => {
    for (const version of versionDirs(provider)) {
      describe(version, () => {
        const manifest = readManifest(provider, version);

        it("manifest agrees with its directory name", () => {
          expect(manifest.provider).toBe(provider);
          expect(manifest.providerVersion).toBe(version);
        });

        it("declares whether it was sanitized", () => {
          expect(typeof manifest.sanitized).toBe("boolean");
        });
      });
    }
  });

  describe("codex-cli 0.140.0-alpha.19", () => {
    const VERSION = "0.140.0-alpha.19";
    const lines = readLines("codex-cli", VERSION, "rollout.jsonl");

    // The capture records its own cli_version. Asserting the directory name
    // against it is what stops a fixture from silently claiming a provenance
    // it does not have.
    it("carries the cli_version the directory claims", () => {
      const meta = lines
        .map((l) => JSON.parse(l))
        .find((e: { type?: string }) => e.type === "session_meta");

      expect(meta?.payload?.cli_version).toBe(VERSION);
    });

    // The core regression: a parser change that starts dropping a shape this
    // provider version genuinely emits fails HERE, loudly, instead of silently
    // rendering an empty conversation in the app.
    it("produces zero unknown events through the adapter", () => {
      const unknown = lines
        .map((line) => ({ line, result: classifyCodexLine(line) }))
        .filter(({ result }) => result.kind === "unknown");

      expect(unknown.map((u) => u.result)).toEqual([]);
    });

    it("yields at least one renderable message", () => {
      const messages = lines.filter((l) => classifyCodexLine(l).kind === "message");
      expect(messages.length).toBeGreaterThan(0);
    });

    it("exercises every envelope type its manifest claims", () => {
      const seen = new Set(lines.map((l) => JSON.parse(l).type));
      for (const t of readManifest("codex-cli", VERSION).envelopeTypes) {
        expect(seen).toContain(t);
      }
    });
  });

  describe("claude-code 2.1.214", () => {
    const VERSION = "2.1.214";
    const lines = readLines("claude-code", VERSION, "conversation.jsonl");

    it("carries the version the directory claims", () => {
      const versions = new Set(
        lines.map((l) => JSON.parse(l).version).filter((v: unknown) => typeof v === "string"),
      );

      expect([...versions]).toEqual([VERSION]);
    });

    it("exercises every envelope type its manifest claims", () => {
      const seen = new Set(lines.map((l) => JSON.parse(l).type));
      for (const t of readManifest("claude-code", VERSION).envelopeTypes) {
        expect(seen).toContain(t);
      }
    });

    // Sanitization is a claim the fixture makes about itself; verify it rather
    // than trusting the manifest, since a bad scrub leaks private transcript
    // content into the repo permanently.
    it("contains no absolute home paths or credential-shaped strings", () => {
      const raw = lines.join("\n");
      expect(raw).not.toMatch(/\/Users\/[a-z]/i);
      expect(raw).not.toMatch(/sk-ant-|ghp_|Bearer\s+\S/);
    });
  });
});
