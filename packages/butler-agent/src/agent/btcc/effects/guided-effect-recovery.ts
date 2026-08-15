import { isAbsolute, posix, win32 } from "node:path";

/** Runtime-owned state needed to reconcile one entry of a guided edit batch. */
export type GuidedEffectRecoveryEntry = {
  path: string;
  startLine: number;
  beforeSha256: string;
  afterSha256: string;
};

const GUIDED_EDIT_BATCH_MIN = 2;
const GUIDED_EDIT_BATCH_MAX = 20;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Hydrate and validate the bounded recovery payload stored for a batch edit.
 * The returned entries are a fresh, normalized copy and never expose absolute
 * workspace paths or file content.
 */
export function normalizeGuidedEffectRecoveryEntries(
  value: unknown,
): GuidedEffectRecoveryEntry[] {
  if (
    !Array.isArray(value) ||
    value.length < GUIDED_EDIT_BATCH_MIN ||
    value.length > GUIDED_EDIT_BATCH_MAX
  ) {
    throw new Error(
      "Guided edit batch recovery entries must contain 2-20 entries",
    );
  }

  const paths = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Guided edit batch recovery entry ${index} is invalid`);
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== 4 ||
      keys.some(
        (key, keyIndex) =>
          key !==
          ["afterSha256", "beforeSha256", "path", "startLine"].sort()[keyIndex],
      )
    ) {
      throw new Error(
        `Guided edit batch recovery entry ${index} has unknown fields`,
      );
    }
    const path = normalizeRecoveryPath(record.path, index);
    if (paths.has(path)) {
      throw new Error(
        `Guided edit batch recovery entry ${index} duplicates a path`,
      );
    }
    paths.add(path);
    if (
      !Number.isSafeInteger(record.startLine) ||
      Number(record.startLine) < 1
    ) {
      throw new Error(
        `Guided edit batch recovery entry ${index} has an invalid start line`,
      );
    }
    const beforeSha256 = normalizeRecoverySha(
      record.beforeSha256,
      index,
      "beforeSha256",
    );
    const afterSha256 = normalizeRecoverySha(
      record.afterSha256,
      index,
      "afterSha256",
    );
    return {
      path,
      startLine: Number(record.startLine),
      beforeSha256,
      afterSha256,
    };
  });
}

function normalizeRecoveryPath(value: unknown, index: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    value.includes("\0") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(
      `Guided edit batch recovery entry ${index} has an invalid path`,
    );
  }
  const slashPath = value.replaceAll("\\", "/");
  const normalized = posix.normalize(slashPath);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith("/") ||
    normalized !== slashPath ||
    slashPath
      .split("/")
      .some((segment) => segment.length === 0 || segment === ".")
  ) {
    throw new Error(
      `Guided edit batch recovery entry ${index} has an invalid path`,
    );
  }
  return normalized;
}

function normalizeRecoverySha(
  value: unknown,
  index: number,
  field: string,
): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(
      `Guided edit batch recovery entry ${index} has an invalid ${field}`,
    );
  }
  return value.toLowerCase();
}
