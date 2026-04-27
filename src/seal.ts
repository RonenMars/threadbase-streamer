import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

export interface SealedPayload {
  ciphertext: string;
  nonce: string;
  ephemeralPublicKey: string;
}

/**
 * Encrypts a plaintext to a recipient's X25519 public key using NaCl box with
 * an ephemeral sender keypair. The phone holds the recipient private key in
 * its own memory and decrypts with nacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientPrivateKey).
 *
 * The wire format is custom (not libsodium crypto_box_seal) but cryptographically equivalent.
 */
export function seal(plaintext: string, recipientPublicKeyBase64: string): SealedPayload {
  const recipientPk = naclUtil.decodeBase64(recipientPublicKeyBase64);
  if (recipientPk.length !== nacl.box.publicKeyLength) {
    throw new Error(
      `clientPublicKey must be ${nacl.box.publicKeyLength} bytes (got ${recipientPk.length})`,
    );
  }
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const message = naclUtil.decodeUTF8(plaintext);
  const cipher = nacl.box(message, nonce, recipientPk, ephemeral.secretKey);
  return {
    ciphertext: naclUtil.encodeBase64(cipher),
    nonce: naclUtil.encodeBase64(nonce),
    ephemeralPublicKey: naclUtil.encodeBase64(ephemeral.publicKey),
  };
}
