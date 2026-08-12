import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const composerDraftSchema = "butler.composer-draft.v1";
const defaultMaxDraftBytes = 64 * 1024;
const defaultMaxDraftEntries = 8;
const defaultMaxDraftAggregateBytes = 512 * 1024;

export function composerDraftFilePath(directory, sessionId) {
  const safeSessionId = normalizeSessionId(sessionId);
  if (!safeSessionId) throw new Error("Invalid composer draft session.");
  const digest = createHash("sha256").update(safeSessionId).digest("hex");
  return join(directory, `${digest}.json`);
}

export function readComposerDraftFile(directory, sessionId, options = {}) {
  try {
    evictComposerDraftDirectory(directory, sessionId, options);
    const value = JSON.parse(
      readFileSync(composerDraftFilePath(directory, sessionId), "utf8"),
    );
    return normalizeSnapshot(value, sessionId, options.maxBytes);
  } catch {
    return null;
  }
}

export function writeComposerDraftFile(directory, value, options = {}) {
  const snapshot = normalizeSnapshot(value, value?.session_id, options.maxBytes);
  if (!snapshot) return { ok: false };
  let temporaryPath = "";
  try {
    mkdirSync(directory, { mode: 0o700, recursive: true });
    chmodSync(directory, 0o700);
    const targetPath = composerDraftFilePath(directory, snapshot.session_id);
    temporaryPath = join(directory, `.${randomUUID()}.tmp`);
    writeFileSync(temporaryPath, `${JSON.stringify(snapshot)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, targetPath);
    chmodSync(targetPath, 0o600);
    evictComposerDraftDirectory(directory, snapshot.session_id, options);
    return { ok: true };
  } catch {
    if (temporaryPath) rmSync(temporaryPath, { force: true });
    return { ok: false };
  }
}

function normalizeSnapshot(value, expectedSessionId, maxBytes = defaultMaxDraftBytes) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sessionId = normalizeSessionId(expectedSessionId);
  if (
    !sessionId ||
    value.schema !== composerDraftSchema ||
    value.session_id !== sessionId ||
    typeof value.text !== "string" ||
    typeof value.updated_at !== "string" ||
    !Number.isFinite(Date.parse(value.updated_at)) ||
    !draftTextWithinBudget(value.text, maxBytes)
  ) return null;
  return {
    schema: composerDraftSchema,
    session_id: sessionId,
    text: value.text,
    updated_at: value.updated_at,
  };
}

function draftTextWithinBudget(text, maxBytes) {
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Math.floor(Number(maxBytes))
    : defaultMaxDraftBytes;
  try {
    return new TextEncoder().encode(text).byteLength <= limit;
  } catch {
    return false;
  }
}

function evictComposerDraftDirectory(directory, protectedSessionId, options = {}) {
  const maxEntries = boundedOption(options.maxEntries, defaultMaxDraftEntries);
  const maxAggregateBytes = boundedOption(
    options.maxAggregateBytes,
    defaultMaxDraftAggregateBytes,
  );
  let entries;
  try {
    entries = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const path = join(directory, name);
        try {
          const raw = readFileSync(path, "utf8");
          const value = JSON.parse(raw);
          const snapshot = normalizeSnapshot(value, value?.session_id, options.maxBytes);
          if (!snapshot) return null;
          return {
            name,
            path,
            sessionId: snapshot.session_id,
            bytes: Buffer.byteLength(raw, "utf8"),
            updatedAt: Date.parse(snapshot.updated_at),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return;
  }
  entries.sort((left, right) =>
    left.updatedAt - right.updatedAt || left.name.localeCompare(right.name),
  );
  let totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  let count = entries.length;
  for (const entry of entries) {
    if (count <= maxEntries && totalBytes <= maxAggregateBytes) break;
    if (entry.sessionId === protectedSessionId) continue;
    try {
      rmSync(entry.path, { force: true });
    } catch {
      continue;
    }
    count -= 1;
    totalBytes -= entry.bytes;
  }
}

function boundedOption(value, fallback) {
  const candidate = Number(value);
  return Number.isInteger(candidate) && candidate > 0 ? candidate : fallback;
}

function normalizeSessionId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    ? value
    : "";
}
