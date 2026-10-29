/** Export only renderer-supplied document content to the file chosen in the save dialog. */
import { writeFile } from "node:fs/promises";
export function registerDocumentExport({ ipcMain, dialog, BrowserWindow, isTrustedSender }) {
  ipcMain.handle("butler:export-document", async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted document export.");
    if (!["markdown", "pdf"].includes(input.format) || typeof input.content !== "string" || typeof input.name !== "string") throw new Error("Invalid document export.");
    const name = input.name.replace(/[<>:"/\\|?*]/gu, "_").split("").map(char => char.charCodeAt(0) < 32 ? "_" : char).join("").replace(/[. ]+$/u, "") || "document";
    const result = await dialog.showSaveDialog({ defaultPath: name });
    if (result.canceled || !result.filePath) return { saved: false };
    if (input.format === "markdown") await writeFile(result.filePath, input.content, "utf8");
    else await printDocument(BrowserWindow, input.content, result.filePath);
    return { saved: true };
  });
}
async function printDocument(BrowserWindow, html, path) {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  try {
    const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">';
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html.replace("<head>", `<head>${policy}`))}`);
    const bytes = await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    await writeFile(path, bytes);
  } finally { window.destroy(); }
}
