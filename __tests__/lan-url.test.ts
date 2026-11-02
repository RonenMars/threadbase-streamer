import { networkInterfaces } from "os";
import { printServerBanner } from "../cli/pair-banner";
import { resolveLanUrl, resolveServerUrl } from "../src/lan-url";

vi.mock("os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("os")>()),
  networkInterfaces: vi.fn(),
}));

const mockIfaces = (value: unknown) =>
  vi.mocked(networkInterfaces).mockReturnValue(value as ReturnType<typeof networkInterfaces>);

describe("resolveLanUrl", () => {
  it("returns the first external IPv4 with the port, skipping loopback and IPv6", () => {
    mockIfaces({
      lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
      en0: [
        { family: "IPv6", internal: false, address: "fe80::1" },
        { family: "IPv4", internal: false, address: "192.0.2.7" },
      ],
    });

    expect(resolveLanUrl(8766)).toBe("http://192.0.2.7:8766");
  });

  it("returns null when the machine has no external IPv4", () => {
    mockIfaces({ lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] });

    expect(resolveLanUrl(8766)).toBeNull();
  });
});

describe("resolveServerUrl", () => {
  it("prefers the public URL, then the LAN URL, then localhost", () => {
    mockIfaces({ en0: [{ family: "IPv4", internal: false, address: "192.0.2.7" }] });
    expect(resolveServerUrl({ publicUrl: "https://tb.example.com", port: 1 })).toBe(
      "https://tb.example.com",
    );
    expect(resolveServerUrl({ publicUrl: null, port: 1 })).toBe("http://192.0.2.7:1");

    mockIfaces({});
    expect(resolveServerUrl({ publicUrl: null, port: 1 })).toBe("http://localhost:1");
  });
});

describe("pairing QR default LAN source", () => {
  it("reads the machine's own LAN address when no override is injected", async () => {
    mockIfaces({ en0: [{ family: "IPv4", internal: false, address: "192.0.2.7" }] });
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      return String(input).endsWith("/api/pair/start")
        ? ok({ token: "pt_x", expiresAt: 1_760_000_000_000, expiresInSeconds: 180 })
        : ok({});
    }) as unknown as typeof globalThis.fetch;
    const log = { info: vi.fn(), warn: vi.fn() };

    await printServerBanner(
      { port: 8766, apiKey: "k", publicUrl: "https://tb.example.com", includeQr: true },
      { log, fetch: fetchFn },
    );

    const line = log.info.mock.calls
      .map(([m]) => String(m))
      .find((m) => m.startsWith("Pair URL: "));
    expect(line).toContain("&lan=http%3A%2F%2F192.0.2.7%3A8766");
  });
});
