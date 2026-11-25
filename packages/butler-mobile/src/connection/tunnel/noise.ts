import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { concat, EMPTY, utf8 } from "./bytes";

export type Keypair = { privateKey: Uint8Array; publicKey: Uint8Array };

/** Noise nonce: 4 zero bytes, then the counter as u64 little-endian. */
function noiseNonce(n: number): Uint8Array {
  const out = new Uint8Array(12), view = new DataView(out.buffer);
  view.setUint32(4, n >>> 0, true);
  view.setUint32(8, Math.floor(n / 2 ** 32), true);
  return out;
}

function hkdf(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(blake2s, ck, ikm);
  const one = hmac(blake2s, temp, Uint8Array.of(1));
  return [one, hmac(blake2s, temp, concat(one, Uint8Array.of(2)))];
}

export class CipherState {
  private n = 0;
  constructor(private readonly key: Uint8Array) {}
  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const out = chacha20poly1305(this.key, noiseNonce(this.n), ad).encrypt(plaintext);
    this.n++;
    return out;
  }
  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const out = chacha20poly1305(this.key, noiseNonce(this.n), ad).decrypt(ciphertext);
    this.n++;
    return out;
  }
}

class SymmetricState {
  h = blake2s(utf8("Noise_IK_25519_ChaChaPoly_BLAKE2s")); // name is 33 bytes > HASHLEN, so h = HASH(name)
  ck: Uint8Array = this.h;
  cipher: CipherState | null = null;
  mixHash(data: Uint8Array) { this.h = blake2s(concat(this.h, data)); }
  mixKey(ikm: Uint8Array) { const [ck, key] = hkdf(this.ck, ikm); this.ck = ck; this.cipher = new CipherState(key); }
  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const out = this.cipher ? this.cipher.encrypt(this.h, plaintext) : plaintext;
    this.mixHash(out);
    return out;
  }
  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const out = this.cipher ? this.cipher.decrypt(this.h, ciphertext) : ciphertext;
    this.mixHash(ciphertext);
    return out;
  }
  /** Second key of Split(): responder → initiator. */
  receiver(): CipherState { return new CipherState(hkdf(this.ck, EMPTY)[1]); }
}

export type PendingHandshake = { symmetric: SymmetricState; e: Keypair; s: Keypair };

/** IK message 1 (-> e, es, s, ss + payload). `ephemeralPrivate` is 32 random bytes from the caller. */
export function writeMessage1(prologue: Uint8Array, s: Keypair, rs: Uint8Array, ephemeralPrivate: Uint8Array, payload: Uint8Array): { message: Uint8Array; pending: PendingHandshake } {
  const symmetric = new SymmetricState();
  symmetric.mixHash(prologue);
  symmetric.mixHash(rs);
  const e = { privateKey: ephemeralPrivate, publicKey: x25519.getPublicKey(ephemeralPrivate) };
  symmetric.mixHash(e.publicKey);
  symmetric.mixKey(x25519.getSharedSecret(e.privateKey, rs));
  const encryptedStatic = symmetric.encryptAndHash(s.publicKey);
  symmetric.mixKey(x25519.getSharedSecret(s.privateKey, rs));
  const encryptedPayload = symmetric.encryptAndHash(payload);
  return { message: concat(e.publicKey, encryptedStatic, encryptedPayload), pending: { symmetric, e, s } };
}

/** IK message 2 (<- e, ee, se + payload); returns the payload and the responder → initiator transport cipher. */
export function readMessage2(pending: PendingHandshake, message: Uint8Array): { payload: Uint8Array; receive: CipherState } {
  if (message.length < 48) throw new Error("tunnel_protocol");
  const { symmetric, e, s } = pending;
  const re = message.subarray(0, 32);
  symmetric.mixHash(re);
  symmetric.mixKey(x25519.getSharedSecret(e.privateKey, re));
  symmetric.mixKey(x25519.getSharedSecret(s.privateKey, re));
  const payload = symmetric.decryptAndHash(message.subarray(32));
  return { payload, receive: symmetric.receiver() };
}
