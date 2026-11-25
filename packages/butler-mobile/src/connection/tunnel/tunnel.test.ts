import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { problemFrom } from "../problems";
import { concat, EMPTY, utf8 } from "./bytes";
import { cloudError } from "./cloudError";
import { readMessage2, writeMessage1 } from "./noise";
import { bodyNonce, BODY_CHUNK, frame, RecordDecoder, sealBody } from "./records";

const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], byte => parseInt(byte, 16));
const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");

// test-category: format-pin
test("Noise IK, transport and request records match the shared vectors", () => {
  const v = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../butler-protocol/fixtures/tunnel-e2e-vectors.json", import.meta.url)), "utf8"));
  const phone = { privateKey: hex(v.phone_static_private), publicKey: x25519.getPublicKey(hex(v.phone_static_private)) };
  expect(toHex(phone.publicKey)).toBe(v.phone_static_public);
  const { message, pending } = writeMessage1(hex(v.prologue), phone, hex(v.desktop_static_public), hex(v.phone_ephemeral_private), hex(v.message1.payload));
  expect(toHex(message)).toBe(v.message1.ciphertext);
  const { payload, receive } = readMessage2(pending, hex(v.message2.ciphertext));
  expect(toHex(payload)).toBe(v.message2.payload);
  for (const step of v.transport) expect(toHex(receive.decrypt(EMPTY, hex(step.ciphertext)))).toBe(step.plaintext);
  const chunks = sealBody(hex(v.body_chunk.key), hex(v.body_chunk.plaintext));
  expect(chunks.map(toHex)).toEqual([v.body_chunk.ciphertext]);
  expect(toHex(concat(frame(message), frame(chunks[0])))).toBe(v.request_records);
});

// test-category: format-pin
test("records reassemble across chunk boundaries and body chunks seal with counter nonces", () => {
  const records = [utf8("a"), new Uint8Array(65_552).fill(7), utf8("end")];
  const wire = concat(...records.map(frame));
  const decoder = new RecordDecoder();
  const got = [wire.subarray(0, 1), wire.subarray(1, 8), wire.subarray(8)].flatMap(part => decoder.push(part));
  expect(got).toEqual(records);
  expect(() => frame(new Uint8Array(65_553))).toThrow();
  expect(() => new RecordDecoder().push(new Uint8Array(4))).toThrow();
  const key = new Uint8Array(32).fill(1);
  const body = new Uint8Array(BODY_CHUNK * 2 + 5).map((_, i) => i % 251);
  const sealed = sealBody(key, body);
  expect(sealed.length).toBe(3);
  const opened = sealed.map((chunk, i) => chacha20poly1305(key, bodyNonce(i), i === 2 ? utf8("end") : EMPTY).decrypt(chunk));
  expect(concat(...opened)).toEqual(body);
  const empty = sealBody(key, EMPTY);
  expect(empty.length).toBe(1);
  expect(chacha20poly1305(key, bodyNonce(0), utf8("end")).decrypt(empty[0])).toEqual(EMPTY);
});

// test-category: pure-logic
test("cloud errors map to connection problems", () => {
  const body = (code: string) => ({ error: { code, message: "m" } });
  expect(problemFrom(cloudError(503, body("desktop_offline")))).toBe("desktopOffline");
  expect(problemFrom(cloudError(404, body("tunnel_not_found")))).toBe("relayOff");
  expect(problemFrom(cloudError(403, body("tunnel_not_in_plan")))).toBe("relayOff");
  expect(problemFrom(cloudError(429, body("tunnel_busy")))).toBe("failed");
  expect(problemFrom(cloudError(503, body("tunnel_paused")))).toBe("failed");
  expect(cloudError(502, null).code).toBe("http_502");
});
