import { createHash } from "node:crypto";
import { stableEffectJson } from "../effects/index.ts";
import {
  normalizeExpectedSha256,
  normalizeWorkspaceContainedPath,
} from "./guided-workspace-file-target.ts";

export const GUIDED_EDIT_BATCH_MIN = 2;
export const GUIDED_EDIT_BATCH_MAX = 20;

const BATCH_TARGET_PREFIX = "workspace:batch:";
const BATCH_TARGET_HASH = /^[a-f0-9]{64}$/u;

export type GuidedWorkspaceFileEditEntry = {
  path: string;
  start_line: number;
  old_text: string;
  new_text: string;
  before_sha256: string;
  after_sha256: string;
};

export type GuidedWorkspaceFileEditBatchInput = {
  edits: readonly GuidedWorkspaceFileEditEntry[];
};

export type GuidedWorkspaceFileEditNormalizedInput =
  | {
      path: string;
      start_line: number;
      old_text: string;
      new_text: string;
      before_sha256: string;
      after_sha256: string;
    }
  | GuidedWorkspaceFileEditBatchInput;

export type DecodedGuidedWorkspaceFileEditEntry = {
  path: string;
  startLine?: number;
  oldText: string;
  newText: string;
};

export function workspaceFileEditBatchTarget(
  input: GuidedWorkspaceFileEditBatchInput,
): string {
  return workspaceFileEditBatchTargetForPaths(input.edits.map((entry) => entry.path));
}

export function workspaceFileEditBatchTargetForPaths(paths: readonly string[]): string {
  return `${BATCH_TARGET_PREFIX}${createHash("sha256")
    .update(stableEffectJson({ version: 1, paths }), "utf8")
    .digest("hex")}`;
}

export function workspaceFileEditBatchTargetForInput(
  input: GuidedWorkspaceFileEditBatchInput,
): string {
  return workspaceFileEditBatchTarget(input);
}

export function normalizeWorkspaceFileEditBatchTarget(target: string): string {
  if (typeof target !== "string" || !target.startsWith(BATCH_TARGET_PREFIX)) {
    throw new Error("edit_file batch target must use workspace:batch:<sha256>");
  }
  const digest = target.slice(BATCH_TARGET_PREFIX.length).toLowerCase();
  if (!BATCH_TARGET_HASH.test(digest)) {
    throw new Error("edit_file batch target must use workspace:batch:<sha256>");
  }
  return `${BATCH_TARGET_PREFIX}${digest}`;
}

export function normalizeGuidedWorkspaceFileEditBatchInput(
  input: unknown,
  workspacePath: string,
): GuidedWorkspaceFileEditBatchInput {
  if (!isRecord(input) || !Array.isArray(input.edits)) {
    throw new Error("edit_file batch effect input requires edits");
  }
  if (
    input.edits.length < GUIDED_EDIT_BATCH_MIN ||
    input.edits.length > GUIDED_EDIT_BATCH_MAX
  ) {
    throw new Error(
      `edit_file batch requires ${GUIDED_EDIT_BATCH_MIN}-${GUIDED_EDIT_BATCH_MAX} entries`,
    );
  }
  const seen = new Set<string>();
  const edits = input.edits.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`edit_file batch entry ${index} must be an object`);
    }
    const unknown = Object.keys(value).filter(
      (key) => !BATCH_INPUT_FIELDS.has(key),
    );
    if (unknown.length > 0) {
      throw new Error(
        `edit_file batch entry rejects unknown input: ${unknown.join(", ")}`,
      );
    }
    if (typeof value.old_text !== "string" || value.old_text.length === 0) {
      throw new Error(
        `edit_file batch entry ${index} old_text must be non-empty`,
      );
    }
    if (typeof value.new_text !== "string") {
      throw new Error(
        `edit_file batch entry ${index} new_text must be a string`,
      );
    }
    if (
      !Number.isSafeInteger(value.start_line) ||
      Number(value.start_line) < 1
    ) {
      throw new Error(
        `edit_file batch entry ${index} start_line must be positive`,
      );
    }
    const path = normalizeWorkspaceContainedPath(
      workspacePath,
      requiredText(value.path, `edits[${index}].path`),
    );
    if (seen.has(path)) {
      throw new Error(`edit_file batch has duplicate target: ${path}`);
    }
    seen.add(path);
    return {
      path,
      start_line: Number(value.start_line),
      old_text: value.old_text,
      new_text: value.new_text,
      before_sha256: requiredSha(value.before_sha256, "before_sha256"),
      after_sha256: requiredSha(value.after_sha256, "after_sha256"),
    } satisfies GuidedWorkspaceFileEditEntry;
  });
  return { edits };
}

export function batchEntries(
  input: GuidedWorkspaceFileEditNormalizedInput,
): readonly GuidedWorkspaceFileEditEntry[] {
  return "edits" in input ? input.edits : [input];
}

export function isGuidedWorkspaceFileEditBatchInput(
  input: GuidedWorkspaceFileEditNormalizedInput,
): input is GuidedWorkspaceFileEditBatchInput {
  return "edits" in input;
}

export function batchInputMatchesTarget(
  target: string,
  input: GuidedWorkspaceFileEditBatchInput,
): boolean {
  try {
    return (
      normalizeWorkspaceFileEditBatchTarget(target) ===
      workspaceFileEditBatchTarget(input)
    );
  } catch {
    return false;
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`edit_file requires ${field}`);
  }
  return value.trim();
}

function requiredSha(value: unknown, field: string): string {
  const normalized = normalizeExpectedSha256(value);
  if (!normalized) throw new Error(`edit_file requires ${field}`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const BATCH_INPUT_FIELDS = new Set([
  "path",
  "start_line",
  "old_text",
  "new_text",
  "before_sha256",
  "after_sha256",
]);
