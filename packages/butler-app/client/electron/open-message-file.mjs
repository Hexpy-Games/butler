// "Open in app" for a stored file. The renderer names the file by id only; the
// agent checks its type and answers the path of a copy it marked as downloaded
// from the internet, which the desktop then opens in its default app.

const fileIdPattern = /^file-[0-9a-f-]{36}$/iu;

/** Registers `butler:open-message-file`; every dependency is injected by main. */
export function registerOpenMessageFile({ ipcMain, serverFetch, openPath, isTrustedSender }) {
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
    const failure = await openPath(path);
    return failure ? { opened: false, code: "open_failed" } : { opened: true };
  });
}
