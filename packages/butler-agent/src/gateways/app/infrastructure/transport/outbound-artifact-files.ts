import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { ArtifactRef } from "../../../core/contracts.ts";
import type { AppMessageResponderFile } from "../../domain/sessions/message-responder-contract.ts";
import type { AppMessageFileStore } from "../../domain/message-files/message-file-store.ts";
import type { ChatRow, ProjectRow } from "../core/records.ts";
import {
  artifactCandidatePaths,
} from "./app-transport-projection.ts";
import {
  messageFileContentKey,
  mimeTypeForArtifactPath,
  normalizeAttachmentMimeType,
  safeAttachmentName,
} from "../../domain/message-files/message-file-storage.ts";
import { isPathInside } from "../core/path-safety.ts";

export function artifactFilesFromOutbound(input: {
  butlerData: string;
  butlerHome: string;
  messageFiles: AppMessageFileStore;
  getChatRow: (chatId: string) => ChatRow | null;
  getProjectRow: (projectId: string) => ProjectRow | null;
  chatId: string;
  artifacts: ArtifactRef[];
  existingMessageId?: string;
}): AppMessageResponderFile[] {
  const chat = input.getChatRow(input.chatId);
  const project = chat?.project_id ? input.getProjectRow(chat.project_id) : null;
  const allowedRoots = [
    input.butlerData,
    ...(project?.workspace_path ? [project.workspace_path] : []),
    join(input.butlerData, "artifacts", "public-data"),
  ].map((root) => resolve(root));
  const files: AppMessageResponderFile[] = [];
  const seen = new Set<string>();
  const existingKeys = input.existingMessageId
    ? new Set(
        input.messageFiles
          .refsForMessage(input.existingMessageId)
          .map((file) =>
            messageFileContentKey(
              file.safe_name,
              file.mime_type,
              file.size_bytes,
              file.sha256,
            ),
          ),
      )
    : new Set<string>();
  for (const artifact of input.artifacts) {
    const path = firstReadableArtifactPath(artifact, allowedRoots, seen, input);
    if (!path) continue;
    seen.add(path);
    const name = basename(
      artifact.safePathLabel?.trim() || artifact.title || path,
    );
    const bytes = readFileSync(path);
    if (bytes.byteLength === 0) continue;
    const safeName = safeAttachmentName(name);
    const mimeType = normalizeAttachmentMimeType(
      artifact.mimeType ?? mimeTypeForArtifactPath(path),
      safeName,
    );
    const key = messageFileContentKey(
      safeName,
      mimeType,
      bytes.byteLength,
      createHash("sha256").update(bytes).digest("hex"),
    );
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    files.push({
      name,
      mimeType,
      bytes,
    });
  }
  return files;
}

function firstReadableArtifactPath(
  artifact: ArtifactRef,
  allowedRoots: string[],
  seen: Set<string>,
  storage: { butlerHome: string; butlerData: string },
): string | null {
  const canonicalRoots = allowedRoots.map(canonicalPath);
  const legacyRoot = resolve(storage.butlerHome, "artifacts");
  for (const candidatePath of artifactCandidatePaths(artifact, allowedRoots)) {
    // Old reports move without rewriting historical message/Turn payloads.
    // Resolve their old references only to data, never read the source copy.
    const path = isPathInside(legacyRoot, candidatePath)
      ? resolve(storage.butlerData, "artifacts", relative(legacyRoot, candidatePath))
      : candidatePath;
    if (seen.has(path)) continue;
    if (!allowedRoots.some((root) => isPathInside(root, path))) continue;
    if (!existsSync(path)) continue;
    try {
      const candidate = lstatSync(path);
      if (!candidate.isFile() || candidate.isSymbolicLink()) continue;
      const real = realpathSync.native(path);
      if (!canonicalRoots.some((root) => isPathInside(root, real))) continue;
      return real;
    } catch {
      continue;
    }
  }
  return null;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}
