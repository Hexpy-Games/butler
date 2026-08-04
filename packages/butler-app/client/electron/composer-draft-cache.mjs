import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const composerDraftSchema = "butler.composer-draft.v1";

export function composerDraftFilePath(directory, sessionId) {
  const safeSessionId = normalizeSessionId(sessionId);
  if (!safeSessionId) throw new Error("Invalid composer draft session.");
  const digest = createHash("sha256").update(safeSessionId).digest("hex");
  return join(directory, `${digest}.json`);
}

export function readComposerDraftFile(directory, sessionId) {
  try {
    const value = JSON.parse(
      readFileSync(composerDraftFilePath(directory, sessionId), "utf8"),
    );
    return normalizeSnapshot(value, sessionId);
  } catch {
    return null;
  }
}

export function writeComposerDraftFile(directory, value) {
  const snapshot = normalizeSnapshot(value, value?.session_id);
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
    return { ok: true };
  } catch {
    if (temporaryPath) rmSync(temporaryPath, { force: true });
    return { ok: false };
  }
}

function normalizeSnapshot(value, expectedSessionId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sessionId = normalizeSessionId(expectedSessionId);
  if (
    !sessionId ||
    value.schema !== composerDraftSchema ||
    value.session_id !== sessionId ||
    typeof value.text !== "string" ||
    typeof value.updated_at !== "string" ||
    !Number.isFinite(Date.parse(value.updated_at))
  ) return null;
  return {
    schema: composerDraftSchema,
    session_id: sessionId,
    text: value.text,
    updated_at: value.updated_at,
  };
}

function normalizeSessionId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    ? value
    : "";
}
