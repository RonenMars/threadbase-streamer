import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { seal } from "../src/seal";

describe("seal", () => {
  it("produces a payload the recipient can decrypt", () => {
    const recipient = nacl.box.keyPair();
    const recipientPkB64 = naclUtil.encodeBase64(recipient.publicKey);

    const apiKey = "tb_super_secret_value_42";
    const sealed = seal(apiKey, recipientPkB64);

    const ciphertext = naclUtil.decodeBase64(sealed.ciphertext);
    const nonce = naclUtil.decodeBase64(sealed.nonce);
    const ephemeralPk = naclUtil.decodeBase64(sealed.ephemeralPublicKey);

    const plain = nacl.box.open(ciphertext, nonce, ephemeralPk, recipient.secretKey);
    expect(plain).not.toBeNull();
    expect(naclUtil.encodeUTF8(plain!)).toBe(apiKey);
  });

  it("uses a fresh ephemeral keypair every call", () => {
    const recipient = nacl.box.keyPair();
    const recipientPkB64 = naclUtil.encodeBase64(recipient.publicKey);
    const a = seal("payload", recipientPkB64);
    const b = seal("payload", recipientPkB64);
    expect(a.ephemeralPublicKey).not.toBe(b.ephemeralPublicKey);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejects an invalid recipient public key", () => {
    expect(() => seal("payload", naclUtil.encodeBase64(new Uint8Array(10)))).toThrow();
  });
});
