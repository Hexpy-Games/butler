import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import type { EffectAdapterError } from "../effects/index.ts";
import { resolveWorkspacePathGuard } from "../../tools/file-tools/index.ts";

export type GuidedWorkspaceEditGuardOptions = {
  butlerData?: string;
  protectedProjectLedgerRoots?: string[];
  workspacePath: string;
};

export type GuidedWorkspaceEditObservation = {
  bytes: number;
  bytesValue: Buffer;
  sha256: string;
  /** Runtime-owned identity for grouping edits to one actual target. */
  identityPath: string;
};

export async function observeGuidedWorkspaceEditTarget(
  options: GuidedWorkspaceEditGuardOptions,
  path: string,
): Promise<
  | { ok: true; value: GuidedWorkspaceEditObservation }
  | { ok: false; error: EffectAdapterError }
> {
  const protectedProjectLedgerRoots = [
    ...(options.butlerData
      ? [join(options.butlerData, "project-ledger", "projects")]
      : []),
    ...(options.protectedProjectLedgerRoots ?? []),
  ];
  try {
    const guard = await resolveWorkspacePathGuard({
      workspaceRoot: options.workspacePath,
      relativePath: path,
      rejectProtectedProjectLedgerWrites: true,
      mutation: true,
      protectedProjectLedgerRoots,
    });
    if (!guard.ok || !guard.absolutePath) {
      return rejected(
        guard.reason ?? "workspace_target_rejected",
        "edit_file only changes an existing regular file inside the admitted workspace.",
      );
    }
    const target = await lstat(guard.absolutePath);
    if (!target.isFile()) {
      return rejected(
        "target_not_regular_file",
        "edit_file only changes an existing regular workspace file.",
      );
    }
    const bytesValue = await readFile(guard.absolutePath);
    return {
      ok: true,
      value: {
        bytes: bytesValue.length,
        bytesValue,
        sha256: guidedWorkspaceBytesSha256(bytesValue),
        identityPath: guard.realPath ?? guard.absolutePath!,
      },
    };
  } catch (error) {
    const cause = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
    return rejected(
      "workspace_target_observation_failed",
      `The existing workspace file could not be observed for editing${cause}.`,
    );
  }
}

export function decodeGuidedWorkspaceUtf8(
  bytes: Buffer,
): { ok: true; text: string } | { ok: false; error: EffectAdapterError } {
  if (bytes.subarray(0, Math.min(bytes.length, 4_096)).includes(0)) {
    return rejected(
      "binary_file_not_supported",
      "edit_file supports valid UTF-8 text files only.",
    );
  }
  try {
    return {
      ok: true,
      text: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes),
    };
  } catch {
    return rejected(
      "invalid_utf8",
      "edit_file supports valid UTF-8 text files only.",
    );
  }
}

export function guidedWorkspaceBytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function rejected(
  code: string,
  message: string,
): { ok: false; error: EffectAdapterError } {
  return { ok: false, error: { code, message } };
}
