import type { BrowserWindow, Dialog, IpcMain, IpcMainInvokeEvent } from "electron";
export function registerDocumentExport(options: { ipcMain: IpcMain; dialog: Dialog; BrowserWindow: typeof BrowserWindow; isTrustedSender: (event: IpcMainInvokeEvent) => boolean }): void;
