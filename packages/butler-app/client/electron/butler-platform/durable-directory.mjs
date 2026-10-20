import { open } from "node:fs/promises";
/** Persist directory entries after an atomic rename or acknowledged unlink. */
export async function syncDirectory(directory) {
  // Windows cannot open directories through the Node file API.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
