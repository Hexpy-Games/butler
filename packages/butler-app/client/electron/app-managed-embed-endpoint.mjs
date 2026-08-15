import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

export function prepareAppManagedEmbedSocket({
  butlerData,
  platform = process.platform,
  socketRoot = "/tmp",
  uid = typeof process.getuid === "function" ? process.getuid() : null,
}) {
  if (platform === "win32") {
    return join(butlerData, "app", "runtime", "embed", "embed.sock");
  }
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error("unable to resolve local user for App-managed embed socket");
  }

  const ownerDir = join(socketRoot, `butler-${uid}`);
  try {
    mkdirSync(ownerDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const ownerStat = lstatSync(ownerDir);
  if (!ownerStat.isDirectory() || ownerStat.uid !== uid) {
    throw new Error("unsafe App-managed embed socket directory");
  }
  chmodSync(ownerDir, 0o700);

  const socketId = createHash("sha256")
    .update(butlerData)
    .digest("hex")
    .slice(0, 20);
  return join(ownerDir, `embed-${socketId}.sock`);
}

/**
 * Return a stable per-data-root health port for App-managed embed services.
 *
 * App-managed services used to receive `EMBED_HEALTH_PORT=0`, which disabled
 * the HTTP endpoint entirely. A deterministic private port avoids collisions
 * between separate Butler data roots while allowing supervisors and operators
 * to probe the same endpoint after every restart.
 */
export function prepareAppManagedEmbedHealthPort({
  butlerData,
  gatewayPort = null,
}) {
  if (typeof butlerData !== "string" || !butlerData.trim()) {
    throw new Error("missing Butler data root for App-managed embed health port");
  }
  const digest = createHash("sha256").update(butlerData).digest();
  const rangeStart = 40_000;
  const rangeSize = 10_000;
  let port = rangeStart + digest.readUInt16BE(0) % rangeSize;
  if (port === gatewayPort) {
    port = rangeStart + ((port - rangeStart + 1) % rangeSize);
  }
  return port;
}
