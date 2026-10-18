export function appendZipEntry(path: string, name: string, data: Uint8Array): Promise<boolean>;
export function registerLogsExport(dependencies: {
  ipcMain: { handle(channel: string, listener: (event: unknown, input?: unknown) => unknown): void };
  dialog: { showSaveDialog(options: { defaultPath: string; buttonLabel: string }): Promise<{ canceled: boolean; filePath?: string }> };
  serverFetch(path: string, init: RequestInit): Promise<Response>;
  readUiCrashes(): Promise<unknown[]>;
  isTrustedSender(event: unknown): boolean;
}): void;
