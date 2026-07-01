import { createHmac, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

const FOLDER_SELECTION_TOKEN_VERSION = "v1";
const FOLDER_SELECTION_TOKEN_TTL_MS = 5 * 60 * 1000;

export function createProjectFolderSelectionToken(
  folderPath: string,
  secret: string,
  options: { nowMs?: number; ttlMs?: number } = {},
): string {
  const issuedAt = Number.isFinite(options.nowMs)
    ? Number(options.nowMs)
    : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs)
    ? Number(options.ttlMs)
    : FOLDER_SELECTION_TOKEN_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({
      path: resolve(folderPath),
      issued_at: issuedAt,
      expires_at: issuedAt + ttlMs,
    }),
    "utf8",
  ).toString("base64url");
  return `${FOLDER_SELECTION_TOKEN_VERSION}.${payload}.${signFolderSelectionPayload(payload, secret)}`;
}

export function readProjectFolderSelectionToken(
  token: string,
  secret?: string,
): string {
  if (!secret) {
    throw new AppStoreOperationError(
      403,
      "folder_selection_unavailable",
      "Project folder selection is unavailable.",
    );
  }
  const [version, payload, signature] = token.split(".");
  if (version !== FOLDER_SELECTION_TOKEN_VERSION || !payload || !signature) {
    throw new AppStoreOperationError(
      400,
      "folder_selection_invalid",
      "Project folder selection is invalid.",
    );
  }
  const expected = signFolderSelectionPayload(payload, secret);
  if (!safeTokenEqual(signature, expected)) {
    throw new AppStoreOperationError(
      400,
      "folder_selection_invalid",
      "Project folder selection is invalid.",
    );
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as {
      path?: unknown;
      expires_at?: unknown;
    };
    if (
      typeof decoded.expires_at === "number" &&
      Date.now() > decoded.expires_at
    ) {
      throw new AppStoreOperationError(
        400,
        "folder_selection_expired",
        "Project folder selection has expired.",
      );
    }
    if (typeof decoded.path !== "string" || decoded.path.trim().length === 0) {
      throw new Error("missing path");
    }
    return resolve(decoded.path);
  } catch (error) {
    if (error instanceof AppStoreOperationError) throw error;
    throw new AppStoreOperationError(
      400,
      "folder_selection_invalid",
      "Project folder selection is invalid.",
    );
  }
}

function signFolderSelectionPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
