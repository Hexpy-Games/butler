export const WALLPAPER_STATE_SESSION_CAP: number;
export interface WallpaperStateLog {
  path: string;
  /** False when the line is malformed or the session cap is reached. */
  record(line: unknown): boolean;
  flushed(): Promise<void>;
}
export function createWallpaperStateLog(dataRoot: string, options?: { now?: () => Date; echo?: (line: string) => void }): WallpaperStateLog;
