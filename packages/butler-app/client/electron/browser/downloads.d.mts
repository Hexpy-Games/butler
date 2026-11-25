interface DownloadItem {
  setSavePath(path: string): void;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  getFilename(): string;
  getURL(): string;
  pause(): void;
  resume(): void;
  cancel(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
}
interface DownloadEntry {
  id: string; name: string; path: string; url: string; bytes: number; total: number;
  state: "progress" | "done" | "failed" | "cancelled"; time: string;
}
export const FILE_LIMIT: number;
export const SESSION_LIMIT: number;
export class BrowserDownloads {
  constructor(browser: {
    downloadRequest: (input: { op: string }) => Promise<unknown>;
    events?: Map<string, unknown[]>;
  }, directory: string);
  active: Set<unknown>;
  totals: Record<string, number>;
  history: DownloadEntry[];
  list(): DownloadEntry[];
  entry(id: string): DownloadEntry | undefined;
  startUser(item: DownloadItem, directory: string): void;
  start(item: DownloadItem, tab: { id: string; owner: string; epoch: number }): void;
  cancelTab(id: string): void;
  cancelEntry(id: string): void;
  stop(): void;
}
