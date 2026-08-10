import {
  normalizeExpectedSha256,
  normalizeWorkspaceContainedPath,
} from "./guided-workspace-file-target.ts";
import {
  normalizeGuidedWorkspaceFileEditBatchInput,
  isGuidedWorkspaceFileEditBatchInput,
  type GuidedWorkspaceFileEditBatchInput,
  type GuidedWorkspaceFileEditEntry,
  type GuidedWorkspaceFileEditNormalizedInput,
} from "./guided-workspace-file-edit-batch.ts";
import { stableEffectJson } from "../effects/index.ts";
import { guidedWorkspaceBytesSha256 } from "./guided-workspace-file-edit-observation.ts";
import type { ExactTextLocation } from "../../tools/file-tools/edit_file/index.ts";
import type { GuidedWorkspaceFileEditInput } from "./guided-workspace-file-edit-contracts.ts";

const INPUT_FIELDS = new Set([
  "path",
  "start_line",
  "old_text",
  "new_text",
  "before_sha256",
  "after_sha256",
]);

export function normalizeGuidedWorkspaceFileEditEffectInput(
  input: unknown,
  workspacePath: string,
): GuidedWorkspaceFileEditNormalizedInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("edit_file effect input must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.edits !== undefined) {
    if (Object.keys(record).some((key) => key !== "edits")) {
      throw new Error("edit_file effect rejects mixed single and batch input");
    }
    return normalizeGuidedWorkspaceFileEditBatchInput(input, workspacePath);
  }
  const unknown = Object.keys(record).filter((key) => !INPUT_FIELDS.has(key));
  if (unknown.length > 0)
    throw new Error(
      `edit_file effect rejects unknown input: ${unknown.join(", ")}`,
    );
  if (
    !Number.isSafeInteger(record.start_line) ||
    Number(record.start_line) < 1
  ) {
    throw new Error("edit_file effect start_line must be a positive integer");
  }
  if (typeof record.old_text !== "string" || record.old_text.length === 0) {
    throw new Error("edit_file effect old_text must be non-empty");
  }
  if (typeof record.new_text !== "string")
    throw new Error("edit_file effect new_text must be a string");
  return {
    path: normalizeWorkspaceContainedPath(
      workspacePath,
      requiredText(record.path, "path"),
    ),
    start_line: Number(record.start_line),
    old_text: record.old_text,
    new_text: record.new_text,
    before_sha256: requiredSha(record.before_sha256, "before_sha256"),
    after_sha256: requiredSha(record.after_sha256, "after_sha256"),
  };
}

function requiredSha(value: unknown, field: string): string {
  const normalized = normalizeExpectedSha256(value);
  if (!normalized) throw new Error(`edit_file effect requires ${field}`);
  return normalized;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`edit_file requires ${field}`);
  return value.trim();
}

export function guidedWorkspaceEditInputSha256(
  value: GuidedWorkspaceFileEditNormalizedInput,
): string {
  return guidedWorkspaceBytesSha256(
    Buffer.from(stableEffectJson(value), "utf8"),
  );
}

type GuidedWorkspaceFileEditNormalizer = {
  normalizeInput(input: unknown): GuidedWorkspaceFileEditNormalizedInput;
};

export function normalizedGuidedWorkspaceEditCandidate(
  input: {
    adapter: GuidedWorkspaceFileEditNormalizer;
    decoded: { path: string; oldText: string; newText: string };
    location: ExactTextLocation;
  },
  hashes: { beforeSha256: string; afterSha256: string },
): GuidedWorkspaceFileEditInput {
  const normalized = input.adapter.normalizeInput({
    path: input.decoded.path,
    start_line: input.location.startLine,
    old_text: input.decoded.oldText,
    new_text: input.decoded.newText,
    before_sha256: hashes.beforeSha256,
    after_sha256: hashes.afterSha256,
  });
  if (isGuidedWorkspaceFileEditBatchInput(normalized)) {
    throw new Error(
      "single guided edit candidate unexpectedly normalized as a batch",
    );
  }
  return normalized;
}

export function normalizedGuidedWorkspaceEditBatchCandidate(input: {
  adapter: GuidedWorkspaceFileEditNormalizer;
  entries: readonly GuidedWorkspaceFileEditEntry[];
}): GuidedWorkspaceFileEditBatchInput {
  const normalized = input.adapter.normalizeInput({
    edits: input.entries,
  });
  if (!isGuidedWorkspaceFileEditBatchInput(normalized)) {
    throw new Error(
      "batch guided edit candidate unexpectedly normalized as a single edit",
    );
  }
  return normalized;
}
