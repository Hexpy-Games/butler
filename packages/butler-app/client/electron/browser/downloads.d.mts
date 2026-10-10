interface DownloadItem {
  setSavePath(path: string): void;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  getFilename(): string;
  pause(): void;
  resume(): void;
  cancel(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
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
  initialize(): Promise<void>;
  start(item: DownloadItem, tab: { id: string; owner: string; epoch: number }): void;
  cancelTab(id: string): void;
  stop(): void;
}
