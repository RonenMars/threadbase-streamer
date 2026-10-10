import { relaySettings } from "../src/relay/hosted";

describe("relaySettings", () => {
  it("uses the hosted relay when server.yaml names none", () => {
    const { relayUrl, relayPublicKey } = relaySettings(undefined, undefined);

    expect(relayUrl).toBe("wss://relay.threadbase.sh/tunnel");
    // An X25519 public key: 32 bytes.
    expect(Buffer.from(relayPublicKey ?? "", "base64url")).toHaveLength(32);
  });

  it("uses the relay server.yaml names", () => {
    expect(relaySettings("wss://relay.example.com/tunnel", "a-key")).toEqual({
      relayUrl: "wss://relay.example.com/tunnel",
      relayPublicKey: "a-key",
    });
  });

  it("never pairs the hosted key with another relay's address, or the reverse", () => {
    expect(relaySettings("wss://relay.example.com/tunnel", undefined)).toEqual({
      relayUrl: "wss://relay.example.com/tunnel",
      relayPublicKey: undefined,
    });
    expect(relaySettings(undefined, "a-key")).toEqual({
      relayUrl: undefined,
      relayPublicKey: "a-key",
    });
  });
});
