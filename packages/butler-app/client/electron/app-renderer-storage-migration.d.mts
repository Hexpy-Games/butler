export type RendererStorageEntry = [key: string, value: string];

export type RendererStorageMigrationResult =
  | { status: "already_migrated" }
  | { status: "migrated"; legacyEntries: number; copied: number }
  | { status: "failed"; code: string };

export const RENDERER_STORAGE_MIGRATION_SCHEMA: "butler.renderer-storage-origin-migration.v1";
export const RENDERER_STORAGE_MIGRATION_MARKER: "renderer-storage-origin-migration.json";
export const RENDERER_STORAGE_KEY_PREFIX: "butler:";
export const RENDERER_STORAGE_BLANK_PAGE_URL: string;
export const READ_RENDERER_STORAGE_SCRIPT: string;

export function writeRendererStorageScript(entries: RendererStorageEntry[]): string;

export function normalizeRendererStorageEntries(raw: unknown): RendererStorageEntry[];

export function migrateRendererStorageOrigin(options: {
  markerPath: string;
  readLegacyEntries: () => Promise<unknown>;
  writeEntries: (entries: RendererStorageEntry[]) => Promise<unknown>;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<RendererStorageMigrationResult>;
