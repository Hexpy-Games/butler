import { relative } from "node:path";
import { resolveWorkspacePathGuard, safeWorkspaceGuardResult } from "../shared/workspace-path-guard.ts";
import { fileToolCapabilityReceipt, fileToolEvidenceReceipt } from "../shared/evidence.ts";
import { getWorkspaceRoot, tryParseToolArgs } from "../shared/args.ts";
import {
  cursorQueryHash,
  decodeFileToolCursor,
  encodeFileToolCursor,
  normalizeOptionalFileToolCursor,
} from "../shared/cursor.ts";
import {
  normalizeGlobArguments,
  normalizeTraversalLimits,
  compareWorkspacePaths,
  traversalSupportsCursor,
  traverseWorkspaceFiles,
  type WorkspaceTraversalEntry,
} from "../shared/workspace-traversal.ts";
import type { FileToolExecutionContext } from "../read_file/executor.ts";
import {
  escapeRegExp,
  fitMatchToBudget,
  mapBounded,
  readCandidate,
  MAX_READ_CONCURRENCY,
  type CandidateReadResult,
  type SearchMatch,
} from "./grep-search.ts";
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
const MAX_OUTPUT_BYTES = 4_194_304;

function normalizePatternArgs(args: Record<string, unknown>):
  | { ok: true; pattern: string; regex: boolean; caseSensitive: boolean }
  | { ok: false; error: "invalid_arguments"; message: string; recovery_hint: string } {
  const pattern = String(args.pattern ?? "").trim();
  const hasMode = Object.prototype.hasOwnProperty.call(args, "mode");
  const hasRegex = Object.prototype.hasOwnProperty.call(args, "regex");
  const mode = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "";
  if (hasMode && mode !== "literal" && mode !== "regex") {
    return { ok: false, error: "invalid_arguments", message: "mode must be literal or regex when supplied as a replay alias.", recovery_hint: "Use canonical regex=true or regex=false." };
  }
  const modeRegex = mode === "regex";
  const regex = Boolean(args.regex ?? false);
  if (hasMode && hasRegex && modeRegex !== regex) {
    return { ok: false, error: "invalid_arguments", message: "regex and replay alias mode disagree.", recovery_hint: "Provide only the canonical regex field." };
  }
  return { ok: true, pattern, regex: hasRegex ? regex : modeRegex, caseSensitive: Boolean(args.case_sensitive ?? true) };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(Math.floor(parsed), max)) : fallback;
}

function normalizeRoot(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return ".";
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  return normalized || ".";
}

function compareCandidates(a: WorkspaceTraversalEntry, b: WorkspaceTraversalEntry): number {
  return compareWorkspacePaths(a.path, b.path);
}

function candidatePriority(path: string): number {
  const segments = path.split("/");
  if (segments.includes("src")) return 0;
  if (
    segments.some((segment) => ["test", "tests", "fixture", "fixtures"].includes(segment)) ||
    /\.(?:spec|test)\.[^/]+$/u.test(path)
  ) return 3;
  if (segments.some((segment) => ["benchmark", "benchmarks", "example", "examples", "scripts"].includes(segment))) return 2;
  return 1;
}

/** Search result order is source-priority within one lexical traversal window. */
function compareSearchCandidates(a: WorkspaceTraversalEntry, b: WorkspaceTraversalEntry): number {
  return candidatePriority(a.path) - candidatePriority(b.path) || compareCandidates(a, b);
}

function compareSearchPosition(a: { path: string }, b: { path: string }): number {
  return candidatePriority(a.path) - candidatePriority(b.path) || compareWorkspacePaths(a.path, b.path);
}

function compareMatch(a: { path: string; line: number }, b: { path: string; line: number }): number {
  return compareSearchPosition(a, b) || a.line - b.line;
}


export async function executeGrepFilesTool(
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
    recovery_hint: "Retry grep_files with pattern and bounded root/glob options.",
    evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, error: parsed.error }),
  };
  const args = parsed.args;
  const workspaceRoot = getWorkspaceRoot(
    args,
    context.workspaceReference?.get() ?? context.workspacePath,
  );
  const root = normalizeRoot(args.root);
  const patternArgs = normalizePatternArgs(args);
  if (!patternArgs.ok) return { ok: false, error: patternArgs.error, message: patternArgs.message, recovery_hint: patternArgs.recovery_hint, evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, error: patternArgs.error }) };
  const { pattern, regex, caseSensitive } = patternArgs;
  const includeResult = normalizeGlobArguments(args, "include_globs", "include");
  const excludeResult = normalizeGlobArguments(args, "exclude_globs", "exclude");
  if (!includeResult.ok) {
    const failure = includeResult;
    return { ok: false, error: failure.error, message: failure.message, recovery_hint: failure.recovery_hint, evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, error: failure.error }) };
  }
  if (!excludeResult.ok) {
    const failure = excludeResult;
    return { ok: false, error: failure.error, message: failure.message, recovery_hint: failure.recovery_hint, evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, error: failure.error }) };
  }
  const includeGlobs = includeResult.value;
  const excludeGlobs = excludeResult.value;
  const hasContextLines = Object.prototype.hasOwnProperty.call(args, "context_lines");
  const hasContextAlias = Object.prototype.hasOwnProperty.call(args, "context");
  const contextLines = boundedInteger(args.context_lines ?? args.context, 0, 0, 10);
  if (hasContextLines && hasContextAlias && boundedInteger(args.context_lines, 0, 0, 10) !== boundedInteger(args.context, 0, 0, 10)) {
    return { ok: false, error: "invalid_arguments", message: "context_lines and replay alias context disagree.", recovery_hint: "Provide only the canonical context_lines field.", evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, error: "invalid_arguments" }) };
  }
  const maxMatches = boundedInteger(args.max_matches, 100, 1, 1000);
  const maxBytesPerFile = boundedInteger(args.max_bytes_per_file, 262_144, 1, 1_048_576);
  const maxOutputBytes = boundedInteger(args.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES);
  const limits = normalizeTraversalLimits(args, { maxResults: boundedInteger(args.max_files, 5000, 1, 50_000) });
  const deadlineAt = startedAt + limits.elapsedMs;
  if (!pattern) return { ok: false, error: "missing_pattern", message: "pattern is required.", recovery_hint: "Provide a non-empty literal pattern or explicit regex pattern.", evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, error: "missing_pattern" }) };
  const query = cursorQueryHash({ workspace_root: workspaceRoot, root, pattern, regex, case_sensitive: caseSensitive, include_globs: includeGlobs, exclude_globs: excludeGlobs, context_lines: contextLines, max_matches: maxMatches, max_bytes_per_file: maxBytesPerFile, max_output_bytes: maxOutputBytes, limits });
  const cursorInput = normalizeOptionalFileToolCursor(args.cursor);
  const cursor = cursorInput === undefined ? null : decodeFileToolCursor(cursorInput);
  if (cursorInput !== undefined && (!cursor || cursor.tool !== "grep_files" || cursor.query !== query)) {
    return { ok: false, error: "invalid_cursor", message: "The grep_files cursor is malformed or does not match the current search options.", recovery_hint: "Restart grep_files with the same pattern/root/globs and omit cursor.", metrics: { elapsed_ms: Math.max(0, Date.now() - startedAt) }, evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, error: "invalid_cursor" }) };
  }
  const guard = await resolveWorkspacePathGuard({ workspaceRoot, relativePath: root, allowDirectories: true, requireDirectory: true, rejectProtectedProjectLedgerPaths: true, protectedProjectLedgerRoots: context.protectedProjectLedgerRoots });
  if (!guard.ok) {
    const error = guard.reason === "directory_not_allowed" || guard.reason === "not_a_directory" ? "not_a_directory" : guard.reason;
    const searchedRoot = root.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(root) || root.split(/[\\/]+/u).includes("..") ? "." : root;
    return { ok: false, error, searched_root: searchedRoot, guard: safeWorkspaceGuardResult(guard), message: "The search root is not an admitted workspace directory.", recovery_hint: "Choose a contained, non-sensitive workspace directory.", evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, path: root, error }) };
  }
  let matcherSource: string;
  try { matcherSource = regex ? pattern : escapeRegExp(pattern); new RegExp(matcherSource, caseSensitive ? "" : "i"); } catch (error) {
    return { ok: false, error: "invalid_pattern", detail: error instanceof Error ? error.message : String(error), message: "The requested search pattern is not valid.", recovery_hint: "Fix the regex or use the default literal mode.", evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: false, error: "invalid_pattern" }) };
  }
  const traversal = await traverseWorkspaceFiles({ workspaceRoot: guard.workspaceRoot, rootPath: guard.realPath ?? guard.absolutePath!, includeGlobs, excludeGlobs, protectedProjectLedgerRoots: context.protectedProjectLedgerRoots, ...(cursor?.scan_path ? { afterPath: cursor.scan_path, includeAfterPath: cursor.scan_inclusive === true } : {}), limits });
  const displayedRoot = relative(guard.workspaceRoot, guard.realPath ?? guard.absolutePath!).replace(/\\/g, "/") || ".";
  // Traversal owns bounded lexical windows. Search preserves the established
  // source-priority order inside one such window, while the cursor carries
  // lexical window bounds so a continuation can resume that same window
  // before advancing the traversal marker.
  const lexicalCandidates = traversal.entries.slice().sort(compareCandidates);
  const windowStartPath = cursor?.window_start_path ?? lexicalCandidates[0]?.path;
  const windowEndPath = cursor?.window_end_path ?? lexicalCandidates[lexicalCandidates.length - 1]?.path;
  const windowCandidates = lexicalCandidates.filter((candidate) => !windowEndPath || compareCandidates(candidate, { path: windowEndPath, absolutePath: "", bytes: 0 }) <= 0);
  const candidates = windowCandidates.slice().sort(compareSearchCandidates);
  const after = cursor?.marker && cursor.line ? { path: cursor.marker, line: cursor.line } : null;
  const searchCandidates = after
    ? candidates.filter((candidate) => compareSearchPosition(candidate, after) >= 0)
    : candidates;
  const matcherFlags = caseSensitive ? "" : "i";
  const candidateResults: CandidateReadResult[] = [];
  const matches: SearchMatch[] = [];
  let outputBytes = 0;
  let maxMatchesReached = false;
  let maxOutputReached = false;
  let stoppedWithinCandidate = false;
  let elapsedBudgetReached = traversal.stoppedBy === "elapsed_ms" || Date.now() >= deadlineAt;

  outer: for (let offset = 0; offset < searchCandidates.length; offset += MAX_READ_CONCURRENCY) {
    if (elapsedBudgetReached || Date.now() >= deadlineAt) {
      elapsedBudgetReached = true;
      break;
    }
    const batch = searchCandidates.slice(offset, offset + MAX_READ_CONCURRENCY);
    const batchResults = await mapBounded(batch, MAX_READ_CONCURRENCY, (candidate) => readCandidate(candidate, matcherSource, matcherFlags, contextLines, maxBytesPerFile, maxMatches, maxOutputBytes, after, { deadlineAt }));
    // All reads in a small deterministic batch are accounted for, even when
    // the first result satisfies the output budget and stops later processing.
    candidateResults.push(...batchResults);
    for (let index = 0; index < batchResults.length; index += 1) {
      const result = batchResults[index]!;
      const candidateMatches = result.matches
        .filter((match) => !after || compareMatch(match, after) > 0)
        .sort(compareMatch);
      for (const candidateMatch of candidateMatches) {
        const hasLaterCandidate = offset + index < searchCandidates.length - 1;
        if (matches.length >= maxMatches) {
          maxMatchesReached = true;
          stoppedWithinCandidate = Boolean(result.withinFileTruncated) || hasLaterCandidate;
          break outer;
        }
        const fitted = fitMatchToBudget(candidateMatch, maxOutputBytes - outputBytes);
        matches.push(fitted.match);
        outputBytes += fitted.bytes;
        if (fitted.truncated || outputBytes >= maxOutputBytes) {
          maxOutputReached = true;
          // A clipped payload is an accounted match, but the cursor must still
          // advance past it so a continuation can prove no later match was
          // silently stranded.
          stoppedWithinCandidate = true;
          break outer;
        }
        if (matches.length >= maxMatches) {
          maxMatchesReached = true;
          stoppedWithinCandidate = Boolean(result.withinFileTruncated) || hasLaterCandidate;
          break outer;
        }
      }
      if (result.withinFileTruncated) {
        stoppedWithinCandidate = true;
        break outer;
      }
    }
    if (batchResults.some((result) => result.reason === "elapsed_ms") || Date.now() >= deadlineAt) {
      elapsedBudgetReached = true;
      break;
    }
  }

  const truncated = traversal.truncated || maxMatchesReached || maxOutputReached || stoppedWithinCandidate || elapsedBudgetReached;
  const partialCandidateResults = candidateResults.filter((result) => result.reason === "max_bytes_per_file" || result.reason === "io_error");
  const partialReasons = [...new Set(partialCandidateResults.map((result) => result.reason!))];
  const candidateIncomplete = partialCandidateResults.length > 0;
  let stoppedBy = traversal.stoppedBy as string | undefined;
  if (elapsedBudgetReached) stoppedBy = "elapsed_ms";
  else if (maxOutputReached) stoppedBy = "max_output_bytes";
  else if (maxMatchesReached) stoppedBy = "max_results";
  else if (candidateIncomplete && !stoppedBy) stoppedBy = partialReasons.includes("io_error") ? "io_error" : "max_bytes_per_file";
  const lastMatch = matches[matches.length - 1];
  const processedCandidate = searchCandidates[Math.min(candidateResults.length, searchCandidates.length) - 1];
  const scanPath = traversal.lastFilePath ?? processedCandidate?.path ?? traversal.lastPath;
  const cursorTraversalSafe = !elapsedBudgetReached && traversalSupportsCursor(traversal.stoppedBy);
  const cursorPayload = cursorTraversalSafe && stoppedWithinCandidate && (lastMatch ?? after)
    ? { tool: "grep_files" as const, query, marker: (lastMatch ?? after)!.path, line: (lastMatch ?? after)!.line, scan_path: windowStartPath, scan_inclusive: true, window_start_path: windowStartPath, window_end_path: windowEndPath }
    : cursorTraversalSafe && traversal.truncated && !maxOutputReached && (!maxMatchesReached || !stoppedWithinCandidate) && scanPath
      ? { tool: "grep_files" as const, query, scan_path: scanPath, scan_inclusive: false }
      : undefined;
  const nextCursor = cursorPayload ? encodeFileToolCursor(cursorPayload) : undefined;
  const filesSkipped = candidateResults.filter((result) => result.skipped).length;
  const filesSearched = candidateResults.filter((result) => !result.skipped).length;
  const ioErrors = traversal.ioErrors + candidateResults.filter((result) => result.reason === "io_error").length;
  const binaryFiles = candidateResults.filter((result) => result.reason === "binary").length;
  const invalidUtf8Files = candidateResults.filter((result) => result.reason === "invalid_utf8").length;
  const metrics = {
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    files_considered: traversal.filesConsidered,
    files_searched: filesSearched,
    files_skipped: filesSkipped,
    candidate_reads: candidateResults.filter((result) => result.attemptedRead).length,
    oversized_files: candidateResults.filter((result) => result.reason === "max_bytes_per_file").length,
    candidate_io_errors: candidateResults.filter((result) => result.reason === "io_error").length,
    io_errors: ioErrors,
    binary_files: binaryFiles,
    invalid_utf8_files: invalidUtf8Files,
    bytes_read: candidateResults.reduce((sum, result) => sum + result.bytesRead, 0),
    output_bytes: outputBytes,
    read_concurrency: MAX_READ_CONCURRENCY,
  };
  return {
    ok: true,
    searched_root: displayedRoot,
    pattern,
    regex,
    case_sensitive: caseSensitive,
    include_globs: includeGlobs,
    exclude_globs: excludeGlobs,
    files_searched: filesSearched,
    files_skipped: filesSkipped,
    binary_files: binaryFiles,
    invalid_utf8_files: invalidUtf8Files,
    io_errors: ioErrors,
    dirs_visited: traversal.dirsVisited,
    files_considered: traversal.filesConsidered,
    matches,
    output_bytes: outputBytes,
    max_output_bytes: maxOutputBytes,
    output_truncated: maxOutputReached,
    truncated: truncated || candidateIncomplete,
    ...(candidateIncomplete ? { partial: true, partial_reasons: partialReasons } : {}),
    ...(stoppedBy ? { stopped_by: stoppedBy } : {}),
    ...(
      elapsedBudgetReached
        ? { recovery_hint: "Search reached timeout_ms before all candidate files were read; narrow the root or globs, raise timeout_ms, and retry without cursor." }
        : candidateIncomplete
        ? { recovery_hint: partialReasons.includes("io_error") ? "Search encountered a candidate I/O error; retry with a narrower admitted root or after checking workspace permissions." : "Some candidates exceeded max_bytes_per_file; raise that bound or narrow the include globs and retry without cursor." }
        : traversal.stoppedBy && !traversalSupportsCursor(traversal.stoppedBy)
          ? { recovery_hint: traversal.stoppedBy === "io_error" ? "Search hit a workspace I/O error; retry grep_files with a narrower admitted root or glob." : "Search stopped before a safe file boundary; narrow the root/globs or raise the directory/depth/time cap and retry without cursor." }
          : {}
    ),
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    metrics,
    evidence_receipts: fileToolEvidenceReceipt({
      toolName: "grep_files",
      summary: `Found ${matches.length} matches for ${pattern}${nextCursor ? " with bounded continuation" : truncated || candidateIncomplete ? " with a bounded partial result" : ""}`,
      references: { searched_root: displayedRoot, pattern, regex, case_sensitive: caseSensitive, include_globs: includeGlobs, exclude_globs: excludeGlobs, files_searched: filesSearched, files_skipped: filesSkipped, binary_files: binaryFiles, invalid_utf8_files: invalidUtf8Files, dirs_visited: traversal.dirsVisited, files_considered: traversal.filesConsidered, io_errors: ioErrors, output_bytes: outputBytes, truncated: truncated || candidateIncomplete, ...(stoppedBy ? { stopped_by: stoppedBy } : {}) },
      satisfies: [],
    }),
    evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "grep_files", ok: true, truncated: truncated || candidateIncomplete, filesSearched, filesSkipped, matches }),
  };
}
