import { networkInterfaces } from "os";
import { detectRoutedAddress, resolveServerUrl } from "../src/lan-url";

const info = vi.hoisted(() => vi.fn());
vi.mock("../src/logger", () => ({ getLogger: () => ({ info }) }));
vi.mock("os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("os")>()),
  networkInterfaces: vi.fn(),
}));

// Two interfaces on one subnet, as in #604: en0 enumerates first, en9 holds the default route.
const TWO_IFACES = {
  lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
  en0: [{ family: "IPv4", internal: false, address: "192.0.2.10" }],
  en9: [{ family: "IPv4", internal: false, address: "192.0.2.20" }],
};

beforeEach(() => {
  info.mockClear();
  vi.mocked(networkInterfaces).mockReturnValue(
    TWO_IFACES as unknown as ReturnType<typeof networkInterfaces>,
  );
});

afterEach(async () => {
  await detectRoutedAddress(async () => {
    throw new Error("reset");
  });
});

const url = () => resolveServerUrl({ publicUrl: null, port: 8766 });

describe("pairing address follows the default route (#604)", () => {
  it("uses the routed address even when another interface enumerates first", async () => {
    await detectRoutedAddress(async () => "192.0.2.20");
    expect(url()).toBe("http://192.0.2.20:8766");
  });

  it("falls back to the first interface when the route lookup fails", async () => {
    await detectRoutedAddress(async () => {
      throw new Error("ENETUNREACH");
    });
    expect(url()).toBe("http://192.0.2.10:8766");
  });

  it("falls back to the first interface when the routed address is not a local one", async () => {
    await detectRoutedAddress(async () => "198.51.100.9");
    expect(url()).toBe("http://192.0.2.10:8766");
  });

  it("logs the chosen address and interface name", async () => {
    await detectRoutedAddress(async () => "192.0.2.20");
    expect(info).toHaveBeenCalledWith(
      "pair.lan_address",
      expect.objectContaining({ address: "192.0.2.20", iface: "en9", routed: true }),
      "pino",
    );
  });

  it("logs the fallback choice as not routed", async () => {
    await detectRoutedAddress(async () => {
      throw new Error("ENETUNREACH");
    });
    expect(info).toHaveBeenCalledWith(
      "pair.lan_address",
      expect.objectContaining({ address: "192.0.2.10", iface: "en0", routed: false }),
      "pino",
    );
  });
});
