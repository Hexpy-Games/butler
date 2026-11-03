// The renderer supplies only an id. The gateway answers the target: a delivered original, or a marked copy under the copy root, and whether its verified content may open or must only be revealed.
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

const fileIdPattern = /^file-[0-9a-f-]{36}$/iu;

/** Refuse links, directories and paths outside the gateway's copy root. */
async function verifiedPath(path, root) {
  try {
    if (!(await lstat(path)).isFile()) return null;
    const [target, base] = await Promise.all([realpath(path), realpath(root)]);
    const inside = relative(base, target);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
    return (await lstat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

/** A gateway-recorded original: exactly the absolute path it answered, still a regular file and not a link. */
async function originalPath(path) {
  try {
    return isAbsolute(path) && (await lstat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** Registers `butler:open-message-file`; every dependency is injected by main. */
export function registerOpenMessageFile({ ipcMain, serverFetch, openPath, showItemInFolder, openedFilesRoot, isTrustedSender }) {
  ipcMain.handle("butler:open-message-file", async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error("invalid_open_file_sender");
    const fileId = typeof input?.fileId === "string" ? input.fileId : "";
    if (!fileIdPattern.test(fileId)) throw new Error("Invalid Butler file.");
    const response = await serverFetch("/internal/opened-files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    const body = await response.json().catch(() => null);
    const path = body?.data?.path;
    if (!response.ok || typeof path !== "string") {
      return { opened: false, code: typeof body?.error?.code === "string" ? body.error.code : "open_copy_failed" };
    }
    const target = body.data.original === true ? await originalPath(path) : await verifiedPath(path, openedFilesRoot);
    if (!target) return { opened: false, code: "open_path_refused" };
    try {
      if (body.data.open === true) {
        const failure = await openPath(target);
        return failure ? { opened: false, code: "open_failed" } : { opened: true };
      }
      await showItemInFolder(target);
      return { opened: true, revealed: true };
    } catch {
      return { opened: false, code: "open_failed" };
    }
  });
}
