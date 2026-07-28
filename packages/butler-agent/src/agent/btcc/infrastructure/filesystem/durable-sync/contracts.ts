export interface DurableSyncAdapter {
  syncFile(path: string): void;
  syncDirectory(path: string): void;
}
