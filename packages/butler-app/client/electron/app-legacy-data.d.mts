export interface AppDataRoots {
  dataRoot: string;
  legacyDataBlocked: boolean;
  /** Null while the data folder is refused: App-owned writes skip it. */
  writableRoot: string | null;
}
export function unsupportedLegacyData(dataRoot: string): boolean;
export function resolveAppDataRoots(env?: Record<string, string | undefined>, home?: string): AppDataRoots;
export function appDataRoots(): Readonly<AppDataRoots>;
