import {
  resolveWorkspacePathGuard,
  safeWorkspaceGuardResult,
  safeWorkspaceResultPath,
} from "../shared/workspace-path-guard.ts";
import { fileToolCapabilityReceipt, fileToolEvidenceReceipt, safeWorkspacePath } from "../shared/evidence.ts";
import { getWorkspaceRoot, tryParseToolArgs } from "../shared/args.ts";
import {
  cursorQueryHash,
  decodeFileToolCursor,
  encodeFileToolCursor,
} from "../shared/cursor.ts";
import {
  DEFAULT_MAX_BYTES,
  MAX_FILE_BYTES,
  integer,
  normalizeRequest,
  normalizedQueryRequests,
  readOneFile,
  utf8Slice,
  cursorSafePath,
  type ReadFileResult,
  type ReadRequest,
} from "./read-content.ts";

export interface FileToolExecutionContext {
  workspacePath?: string;
  protectedProjectLedgerRoots?: string[];
}

const MAX_BATCH_REQUESTS = 20;
const DEFAULT_MAX_TOTAL_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 4_194_304;

function invalidCursorResult(error: "invalid_cursor" | "cursor_stale", message: string, recoveryHint: string): ReadFileResult {
  return { ok: false, error, message, recovery_hint: recoveryHint };
}

export async function executeReadFileTool(
  call: { arguments?: unknown; input?: unknown; args?: unknown },
  context: FileToolExecutionContext = {},
) {
  const startedAt = Date.now();
  const parsed = tryParseToolArgs(call);
  if (!parsed.ok) return {
    ok: false,
    error: parsed.error,
    detail: parsed.detail,
    message: "Tool arguments must be a JSON object.",
    recovery_hint: "Retry read_file with path or requests.",
    evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "read_file", ok: false, error: parsed.error }),
  };
  const args = parsed.args;
  const hasPath = typeof args.path === "string" && args.path.trim().length > 0;
  const hasRequests = args.requests !== undefined;
  if ((hasPath && hasRequests) || (!hasPath && !hasRequests)) {
    return { ok: false, error: "invalid_arguments", message: "Provide exactly one of path or requests.", recovery_hint: "Use path for one file or requests for 1-20 files.", evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "read_file", ok: false, error: "invalid_arguments" }) };
  }
  const requests: (ReadRequest | null)[] = hasPath
    ? [{ path: String(args.path).trim(), max_bytes: integer(args.max_bytes, DEFAULT_MAX_BYTES, 1, MAX_FILE_BYTES), ...(args.start_line === undefined ? {} : { start_line: integer(args.start_line, 1, 1, 10_000_000) }), ...(args.limit_lines === undefined ? {} : { limit_lines: integer(args.limit_lines, 1, 1, 10_000) }) }]
    : (Array.isArray(args.requests) ? args.requests.map(normalizeRequest) : []);
  if (requests.length === 0 || requests.length > MAX_BATCH_REQUESTS || requests.some((request) => request === null)) {
    return { ok: false, error: "invalid_arguments", message: "requests must contain 1-20 objects with a path.", recovery_hint: "Retry with one path or 1-20 canonical request objects.", evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "read_file", ok: false, error: "invalid_arguments" }) };
  }
  const normalizedRequests = requests as ReadRequest[];
  const maxTotalBytes = integer(args.max_total_bytes, hasPath ? normalizedRequests[0]!.max_bytes : DEFAULT_MAX_TOTAL_BYTES, 1, MAX_TOTAL_BYTES);
  const query = cursorQueryHash(normalizedQueryRequests(normalizedRequests, maxTotalBytes));
  const cursor = args.cursor === undefined ? null : decodeFileToolCursor(args.cursor);
  if (args.cursor !== undefined && (!cursor || cursor.tool !== "read_file" || cursor.query !== query)) {
    return invalidCursorResult("invalid_cursor", "The read_file cursor is malformed or does not match the current request options.", "Restart read_file with the same path or requests and omit cursor.");
  }
  const cursorIndex = cursor?.request_index ?? 0;
  if (cursorIndex < 0 || cursorIndex >= normalizedRequests.length) {
    return invalidCursorResult("invalid_cursor", "The read_file cursor points outside the requested batch.", "Restart the batch without cursor.");
  }
  if (cursor && (!cursor.file_sha256 || cursor.offset_bytes === undefined)) {
    return invalidCursorResult("invalid_cursor", "The read_file cursor is missing its partial-file revision marker.", "Restart the affected file read without cursor.");
  }

  const workspaceRoot = getWorkspaceRoot(args, context.workspacePath);
  const suppliedWorkspaceRoot = typeof args.workspace_root === "string" ? args.workspace_root.trim() : "";
  if (context.workspacePath && suppliedWorkspaceRoot) {
    for (const request of normalizedRequests) {
      const suppliedGuard = await resolveWorkspacePathGuard({
        workspaceRoot: suppliedWorkspaceRoot,
        relativePath: request.path,
        rejectProtectedProjectLedgerPaths: true,
        protectedProjectLedgerRoots: context.protectedProjectLedgerRoots,
      });
      if (!suppliedGuard.ok && suppliedGuard.reason === "protected_path") {
        const safePath = safeWorkspaceResultPath({
          workspaceRoot: suppliedGuard.workspaceRoot,
          requestedPath: request.path,
          absolutePath: suppliedGuard.absolutePath,
        });
        return {
          ok: false,
          error: suppliedGuard.reason,
          ...(safePath === undefined ? {} : { path: safePath }),
          guard: safeWorkspaceGuardResult(suppliedGuard),
          message: "Project Ledger files must be inspected through their dedicated tool policy.",
          recovery_hint: "Use the admitted workspace root or the Project Ledger inspection tools.",
          evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "read_file", ok: false, path: safePath, error: suppliedGuard.reason }),
        };
      }
    }
  }

  const results: ReadFileResult[] = [];
  let totalOutputBytes = 0;
  let totalInputBytes = 0;
  let filesRead = 0;
  let nextCursor: string | undefined;
  let aggregateTruncated = false;
  for (let index = 0; index < normalizedRequests.length; index += 1) {
    const request = normalizedRequests[index]!;
    if (index < cursorIndex) {
      results.push({ ok: true, path: request.path, skipped: true, content: "", bytes: 0, truncated: false });
      continue;
    }
    const continuationOffset = index === cursorIndex && cursor?.offset_bytes !== undefined ? cursor.offset_bytes : undefined;
    const read = await readOneFile(request, workspaceRoot, context, continuationOffset);
    // bytes_read describes filesystem input, not the bounded response payload.
    // Count bytes obtained even when decoding rejects the file or response
    // clipping later reduces the returned content.
    totalInputBytes += read.bytesRead;
    if (cursor && index === cursorIndex && read.sha256 !== cursor.file_sha256) {
      return invalidCursorResult("cursor_stale", "The partially-read file changed after the cursor was issued.", "Restart read_file for that file without cursor and re-read its current contents.");
    }
    if (cursor && index === cursorIndex && read.cursorInvalid) {
      return invalidCursorResult("invalid_cursor", "The read_file cursor offset is outside the current UTF-8 byte boundaries.", "Restart read_file without cursor and continue from a newly issued cursor.");
    }
    if (!read.result.ok) {
      results.push(read.result);
      continue;
    }
    if (totalOutputBytes >= maxTotalBytes) {
      aggregateTruncated = true;
      results.push({ ok: false, path: request.path, error: "max_total_bytes", message: "The aggregate read byte budget was reached before this file.", recovery_hint: "Continue with the returned next_cursor or lower the batch size." });
      nextCursor = encodeFileToolCursor({ tool: "read_file", query, request_index: index, offset_bytes: read.startOffset ?? continuationOffset ?? 0, ...(cursorSafePath(request.path) ? { file_path: cursorSafePath(request.path) } : {}), file_sha256: read.sha256 });
      for (let pending = index + 1; pending < normalizedRequests.length; pending += 1) {
        results.push({ ok: false, path: normalizedRequests[pending]!.path, error: "max_total_bytes", message: "The aggregate read byte budget was reached before this file.", recovery_hint: "Continue with next_cursor to read the remaining requests." });
      }
      break;
    }
    const available = maxTotalBytes - totalOutputBytes;
    if (read.outputBytes > available) {
      const clipped = utf8Slice(String(read.result.content ?? ""), available);
      if (clipped.bytes === 0 && read.outputBytes > 0) {
        aggregateTruncated = true;
        results.push({ ok: false, path: request.path, error: "max_total_bytes", message: "The aggregate read byte budget cannot include the next UTF-8 character without splitting it.", recovery_hint: "Increase max_total_bytes and retry this request." });
        for (let pending = index + 1; pending < normalizedRequests.length; pending += 1) {
          results.push({ ok: false, path: normalizedRequests[pending]!.path, error: "max_total_bytes", message: "The aggregate read byte budget was reached before this file.", recovery_hint: "Increase max_total_bytes and retry the remaining requests." });
        }
        break;
      }
      read.result.content = clipped.content;
      read.result.byte_truncated = true;
      read.result.truncated = true;
      if (typeof read.result.start_line === "number") {
        const contentLines = clipped.content.length ? clipped.content.split("\n") : [];
        read.result.end_line = contentLines.length
          ? read.result.start_line + contentLines.length - 1
          : read.result.start_line - 1;
      }
      read.outputBytes = clipped.bytes;
      aggregateTruncated = true;
      const startOffset = read.startOffset ?? continuationOffset ?? 0;
      nextCursor = encodeFileToolCursor({ tool: "read_file", query, request_index: index, offset_bytes: startOffset + clipped.bytes, ...(cursorSafePath(request.path) ? { file_path: cursorSafePath(request.path) } : {}), file_sha256: read.sha256 });
    } else if (read.hasMore && read.nextOffset !== undefined) {
      aggregateTruncated = true;
      nextCursor = encodeFileToolCursor({ tool: "read_file", query, request_index: index, offset_bytes: read.nextOffset, ...(cursorSafePath(request.path) ? { file_path: cursorSafePath(request.path) } : {}), file_sha256: read.sha256 });
    }
    totalOutputBytes += read.outputBytes;
    filesRead += 1;
    results.push(read.result);
    if (nextCursor) {
      for (let pending = index + 1; pending < normalizedRequests.length; pending += 1) {
        results.push({ ok: false, path: normalizedRequests[pending]!.path, error: "max_total_bytes", message: "The aggregate read byte budget was reached before this file.", recovery_hint: "Continue with next_cursor to read the remaining requests." });
      }
      break;
    }
  }
  const metrics = {
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    files_read: filesRead,
    bytes_read: totalInputBytes,
    output_bytes: totalOutputBytes,
    files_requested: normalizedRequests.length,
  };
  if (hasPath) {
    const single = results.find((result) => result.path === normalizedRequests[0]!.path) ?? results[0];
    if (!single) return { ok: false, error: "io_error", message: "The file read did not produce a result.", metrics };
    const safeSinglePath = safeWorkspacePath(normalizedRequests[0]!.path);
    return {
      ...single,
      ...(aggregateTruncated || nextCursor ? { truncated: true } : {}),
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      metrics,
      evidence_receipts: single.ok
        ? fileToolEvidenceReceipt({ toolName: "read_file", summary: `Read ${single.truncated ? "truncated " : ""}workspace file`, references: { ...(safeSinglePath ? { path: safeSinglePath } : {}), bytes: single.bytes, sha256: single.sha256, truncated: Boolean(single.truncated), start_line: single.start_line, end_line: single.end_line }, satisfies: safeSinglePath ? ["source_verified"] : [] })
        : undefined,
      evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "read_file", ok: single.ok && Boolean(safeSinglePath), path: normalizedRequests[0]!.path, bytes: single.bytes, sha256: single.sha256, truncated: single.truncated, error: single.ok && !safeSinglePath ? "unsafe_reference" : single.error }),
    };
  }
  const batchEvidenceFiles = results.slice(0, MAX_BATCH_REQUESTS).flatMap((result) => {
    const path = safeWorkspacePath(result.path);
    return path && result.ok && result.skipped !== true ? [{ path, bytes: result.bytes, sha256: result.sha256 }] : [];
  }).slice(0, 12);
  return {
    ok: true,
    files: results,
    files_requested: normalizedRequests.length,
    files_read: filesRead,
    bytes_read: totalInputBytes,
    output_bytes: totalOutputBytes,
    truncated: aggregateTruncated || Boolean(nextCursor),
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    metrics,
    evidence_receipts: fileToolEvidenceReceipt({
      toolName: "read_file",
      summary: `Read ${filesRead} workspace files${nextCursor ? " with bounded continuation" : aggregateTruncated ? " with a bounded partial result" : ""}`,
      references: { files: batchEvidenceFiles, truncated: aggregateTruncated || Boolean(nextCursor) },
      satisfies: batchEvidenceFiles.length > 0 ? ["source_verified"] : [],
    }),
    evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "read_file", ok: batchEvidenceFiles.length > 0, truncated: aggregateTruncated || Boolean(nextCursor), files: results, error: batchEvidenceFiles.length > 0 ? undefined : "all_files_failed" }),
  };
}
