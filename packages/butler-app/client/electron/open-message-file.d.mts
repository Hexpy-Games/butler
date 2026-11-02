interface OpenFileInput {
  fileId?: unknown;
  reveal?: unknown;
  [key: string]: unknown;
}
interface OpenFileResult { opened: boolean; revealed?: boolean; code?: string }
export function registerOpenMessageFile(dependencies: {
  ipcMain: { handle(channel: string, callback: (event: unknown, input?: OpenFileInput) => Promise<OpenFileResult>): void };
  serverFetch(url: string, options: { method: string; body: string }): Promise<Pick<Response, "ok" | "json">>;
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void | Promise<void>;
  openedFilesRoot: string;
  isTrustedSender(event: unknown): boolean;
}): void;
