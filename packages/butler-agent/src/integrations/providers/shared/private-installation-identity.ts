import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PRIVATE_INSTALLATION_KEY_FILE = ".private-installation.key";

export function loadPrivateInstallationKey(
  butlerData = process.env.BUTLER_DATA || join(homedir(), ".butler"),
): Buffer {
  const directory = join(butlerData, "metrics");
  const path = join(directory, PRIVATE_INSTALLATION_KEY_FILE);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(path)) publishInstallationKey(path, directory);
  chmodSync(path, 0o600);
  return validateEncodedInstallationKey(readFileSync(path, "utf8"));
}

export function privateInstallationDigest(
  key: Buffer,
  purpose: "bounded-continuation-v1" | "phase-continuity-projection-v1",
  value: string,
): string {
  const input = `${purpose}\0${value}`;
  return createHmac("sha256", key).update(input, "utf8").digest("base64url").slice(0, 43);
}

function publishInstallationKey(path: string, directory: string): void {
  const temporary = join(directory, `${PRIVATE_INSTALLATION_KEY_FILE}.${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, randomBytes(32).toString("base64url"), "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    validateEncodedInstallationKey(readFileSync(temporary, "utf8"));
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

function validateEncodedInstallationKey(value: string): Buffer {
  const encoded = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw new Error("invalid_private_installation_key");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== 32) throw new Error("invalid_private_installation_key_entropy");
  return decoded;
}
