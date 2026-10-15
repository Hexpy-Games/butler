export const WALLPAPER_STATE_SESSION_CAP: number;
export interface WallpaperStateLog<Path extends string | null = string> {
  /** Null when there is no accepted data root: lines are echoed only. */
  path: Path;
  /** False when the line is malformed or the session cap is reached. */
  record(line: unknown): boolean;
  flushed(): Promise<void>;
}
type WallpaperStateLogOptions = { now?: () => Date; echo?: (line: string) => void };
export function createWallpaperStateLog(dataRoot: string, options?: WallpaperStateLogOptions): WallpaperStateLog;
export function createWallpaperStateLog(dataRoot: string | null, options?: WallpaperStateLogOptions): WallpaperStateLog<string | null>;
