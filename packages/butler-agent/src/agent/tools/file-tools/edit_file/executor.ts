import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { getWorkspaceRoot, tryParseToolArgs } from "../shared/args.ts";
import {
  fileToolCapabilityReceipt,
  fileToolEvidenceReceipt,
  sha256Hex,
} from "../shared/evidence.ts";
import { locateExactText } from "./exact-text-locator.ts";
import { resolveWorkspacePathGuard } from
  "../shared/workspace-path-guard.ts";
import type { FileToolExecutionContext } from "../read_file/executor.ts";
import { withButlerFileMutationLock } from
  "../shared/workspace-file-mutation-lock.ts";

type ToolCall = {
  arguments?: unknown;
  input?: unknown;
  args?: unknown;
};

function failure(input: {
  error: string;
  path?: string;
  details?: Record<string, unknown>;
}) {
  return {
    ok: false as const,
    error: input.error,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...input.details,
    evidence_capability_receipts: fileToolCapabilityReceipt({
      toolName: "edit_file",
      ok: false,
      path: input.path,
      error: input.error,
    }),
  };
}

function decodeUtf8(data: Buffer):
  | { ok: true; text: string }
  | { ok: false; error: "binary_file_not_supported" | "invalid_utf8" } {
  if (data.subarray(0, Math.min(data.length, 4096)).includes(0)) {
    return { ok: false, error: "binary_file_not_supported" };
  }
  try {
    return {
      ok: true,
      text: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(data),
    };
  } catch {
    return { ok: false, error: "invalid_utf8" };
  }
}

async function atomicReplace(
  filePath: string,
  data: Buffer,
  mode: number,
): Promise<void> {
  const temporaryPath = `${filePath}.butler-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, data, { flag: "wx", mode });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function executeEditFileTool(
  call: ToolCall,
  context: FileToolExecutionContext = {},
) {
  const parsed = tryParseToolArgs(call);
  if (!parsed.ok) {
    return failure({
      error: parsed.error,
      details: { detail: parsed.detail },
    });
  }

  const args = parsed.args;
  const workspaceRoot = getWorkspaceRoot(args, context.workspacePath);
  const path = typeof args.path === "string" ? args.path : "";
  const startLine = args.start_line === undefined ? undefined : Number(args.start_line);
  const oldText = args.old_text;
  const newText = args.new_text;
  const expectedSha256 = typeof args.expected_sha256 === "string"
    ? args.expected_sha256
    : undefined;

  if (startLine !== undefined && (!Number.isSafeInteger(startLine) || startLine < 1)) {
    return failure({ error: "invalid_start_line", path });
  }
  if (typeof oldText !== "string" || oldText.length === 0) {
    return failure({ error: "old_text_required", path });
  }
  if (typeof newText !== "string") {
    return failure({ error: "new_text_required", path });
  }

  const guard = await resolveWorkspacePathGuard({
    workspaceRoot,
    relativePath: path,
    rejectProtectedProjectLedgerWrites: true,
    protectedProjectLedgerRoots: context.protectedProjectLedgerRoots,
  });
  if (!guard.ok) {
    return failure({
      error: guard.reason ?? "path_rejected",
      path,
      details: { guard },
    });
  }

  const filePath = guard.absolutePath!;
  return withButlerFileMutationLock(async () => {
    const target = await lstat(filePath);
    if (!target.isFile()) {
      return failure({ error: "target_not_regular_file", path });
    }

    const before = await readFile(filePath);
    const decoded = decodeUtf8(before);
    if (!decoded.ok) {
      return failure({
        error: decoded.error,
        path,
        details: { bytes: before.length },
      });
    }

    const beforeSha256 = sha256Hex(before);
    if (expectedSha256 !== undefined && expectedSha256 !== beforeSha256) {
      return failure({
        error: "expected_sha256_mismatch",
        path,
        details: {
          before_sha256: beforeSha256,
          expected_sha256: expectedSha256,
        },
      });
    }

    const location = locateExactText({
      text: decoded.text,
      oldText,
      ...(startLine === undefined ? {} : { startLine }),
    });
    if (!location.ok) {
      return failure({
        error: location.error,
        path,
        details: {
          ...(startLine === undefined ? {} : { start_line: startLine }),
          before_sha256: beforeSha256,
          occurrences: location.occurrenceCount,
        },
      });
    }

    const afterText = `${decoded.text.slice(0, location.value.offset)}${newText}${
      decoded.text.slice(location.value.offset + oldText.length)
    }`;
    const afterData = Buffer.from(afterText, "utf8");
    await atomicReplace(filePath, afterData, target.mode);

    const persisted = await readFile(filePath);
    const afterSha256 = sha256Hex(persisted);
    return {
      ok: true,
      path,
      start_line: location.value.startLine,
      replacements: 1,
      bytes: persisted.length,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      atomic_write: true,
      evidence_receipts: fileToolEvidenceReceipt({
        toolName: "edit_file",
        summary: `Edited workspace file ${path}`,
        references: {
          path,
          start_line: location.value.startLine,
          replacements: 1,
          before_sha256: beforeSha256,
          after_sha256: afterSha256,
          atomic_write: true,
        },
        satisfies: ["durable_artifact"],
      }),
      evidence_capability_receipts: fileToolCapabilityReceipt({
        toolName: "edit_file",
        ok: true,
        path,
        edited: true,
        overwritten: true,
        bytes: persisted.length,
      }),
    };
  });
}
