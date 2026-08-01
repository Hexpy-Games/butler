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
