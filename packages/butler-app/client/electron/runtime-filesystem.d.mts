export interface RuntimeSiblingEntry {
  name: string;
  mtimeMs: number;
}

export interface RenameOptions {
  platform?: NodeJS.Platform | string;
  attempts?: number;
  rename?: (source: string, target: string) => void;
  delay?: (milliseconds: number) => void;
}

export function managedRuntimeExecutablePath(
  runtimeHome: string,
  platform?: NodeJS.Platform | string,
): string;

export function managedRuntimeSourceExecutablePath(
  resourceRoot: string,
  platform?: NodeJS.Platform | string,
): string;

export function normalizeArchivePath(
  entryName: string,
  platform?: NodeJS.Platform | string,
): string;

export function archiveTargetPath(
  root: string,
  entryName: string,
  platform?: NodeJS.Platform | string,
): string;

export function pathIsInside(
  root: string,
  candidate: string,
  platform?: NodeJS.Platform | string,
): boolean;

export function assertSafeExtractionTarget(
  root: string,
  target: string,
  options?: {
    platform?: NodeJS.Platform | string;
    lstat?: (path: string) => { isSymbolicLink(): boolean };
    realpath?: (path: string) => string;
  },
): void;

export function safeArchiveSymlinkTarget(
  root: string,
  target: string,
  linkName: string,
  platform?: NodeJS.Platform | string,
): string;

export function renameWithRetrySync(
  source: string,
  target: string,
  options?: RenameOptions,
): void;

export function removeStaleRuntimeSiblingsSync(
  runtimeHome: string,
  options: {
    platform?: NodeJS.Platform | string;
    entries: RuntimeSiblingEntry[];
    now?: number;
    maxAgeMs?: number;
    remove?: (path: string, options: { recursive: true; force: true }) => void;
    exists?: (path: string) => boolean;
    rename?: (source: string, target: string) => void;
  },
): { recoveredBackup: string | null };
