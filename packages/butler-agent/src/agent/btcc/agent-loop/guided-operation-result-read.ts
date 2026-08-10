import type {
  GuidedExactResultSelector,
  SqliteGuidedToolJournal,
} from "../../adapters/index.ts";
import type { GuidedOperationResultViewSelector } from
  "../../tools/m1-compact-replay.ts";
import { selectGuidedOperationResultView } from
  "./guided-operation-result-view.ts";
import { guidedOperationStructuralFacts } from
  "./guided-tool-context-projection.ts";

/** Re-executes bounded selectors against durable exact results without dispatch. */
export function readGuidedOperationResultViews(input: {
  args: Record<string, unknown>;
  toolJournal: SqliteGuidedToolJournal;
  boundWorkId: string | null;
  scope: { sessionId: string; projectRef?: string; workId?: string };
  maxOutputTokens: number;
}) {
  const reads = parseExactSelectors(input.args);
  if (!input.boundWorkId && reads.some((read) =>
    read.identity.kind === "work")) {
    throw new Error("guided_result_work_context_required");
  }
  const exactResults = input.toolJournal.readExactResultRange({
    selectors: reads.map((read) => read.identity),
    scope: input.scope,
  });
  return {
    resultRef: exactResults[0]?.resultRef ?? null,
    views: exactResults.map((result, index) => {
      const read = reads[index]!;
      const selected = selectGuidedOperationResultView({
        result,
        selector: read.selector,
        maxOutputTokens: input.maxOutputTokens,
      });
      return {
        identity: providerIdentity(
          read.identity,
          result,
        ),
        selector: selected.selector,
        view: selected.view,
      };
    }),
  };
}

function parseExactSelectors(args: Record<string, unknown>) {
  if (!Array.isArray(args.reads) || args.reads.length < 1 ||
    args.reads.length > 4) {
    throw new Error("guided_result_range_invalid");
  }
  const reads = args.reads.map((value) => {
    const record = object(value, "read_selector");
    const resultRef = requiredText(record.result_ref, "result_ref", 200);
    const resultSha256 = nullableDigest(record.result_sha256);
    const selector = parseViewSelector(record.selector);
    if (record.kind === "work") {
      if (!Number.isInteger(record.revision) || Number(record.revision) < 1) {
        throw new Error("guided_result_revision_required");
      }
      return {
        identity: {
          kind: "work" as const,
          resultRef,
          workId: requiredText(record.work_id, "work_id", 200),
          revision: Number(record.revision),
          resultSha256,
        },
        selector,
      };
    }
    if (record.kind === "direct" && record.revision === null) {
      return {
        identity: {
          kind: "direct" as const,
          resultRef,
          revision: null,
          resultSha256,
        },
        selector,
      };
    }
    throw new Error("guided_result_selector_kind_invalid");
  });
  const identities = new Set<string>();
  for (const read of reads) {
    const identity = JSON.stringify([read.identity, read.selector]);
    if (identities.has(identity)) {
      throw new Error("guided_result_range_duplicate_selector");
    }
    identities.add(identity);
  }
  return reads;
}

function parseViewSelector(value: unknown): GuidedOperationResultViewSelector {
  const selector = object(value, "view_selector");
  const pointer = requiredText(selector.pointer, "pointer", 500);
  if (selector.kind === "json_pointer") return { kind: selector.kind, pointer };
  if (selector.kind === "line_range") {
    return {
      kind: selector.kind,
      pointer,
      start_line: integer(selector.start_line, "start_line", 1),
      end_line: integer(selector.end_line, "end_line", 1),
    };
  }
  if (selector.kind === "byte_range") {
    return {
      kind: selector.kind,
      pointer,
      start_byte: integer(selector.start_byte, "start_byte", 0),
      end_byte: integer(selector.end_byte, "end_byte", 1),
    };
  }
  if (selector.kind === "search") {
    const maxMatches = integer(selector.max_matches, "max_matches", 1);
    if (maxMatches > 20) throw new Error("compact_replay_max_matches_invalid");
    return {
      kind: selector.kind,
      pointer,
      query: requiredText(selector.query, "query", 500),
      max_matches: maxMatches,
    };
  }
  throw new Error("compact_replay_view_selector_kind_invalid");
}

function providerIdentity(
  identity: GuidedExactResultSelector,
  result: ReturnType<SqliteGuidedToolJournal["readExactResult"]>,
) {
  return {
    kind: identity.kind,
    result_ref: identity.resultRef,
    ...(identity.kind === "work" ? { work_id: identity.workId } : {}),
    revision: identity.revision,
    tool_name: result.toolName,
    status: result.status,
    result_sha256: identity.resultSha256,
    ...guidedOperationStructuralFacts({
      toolName: result.toolName,
      status: result.status,
      result: result.result,
      resultSha256: result.resultSha256,
      structuralFacts: result.structuralFacts,
    }),
  };
}

function integer(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`compact_replay_${field}_invalid`);
  }
  return Number(value);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`compact_replay_${field}_invalid`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) {
    throw new Error(`compact_replay_${field}_invalid`);
  }
  return text;
}

function nullableDigest(value: unknown): string | null {
  if (value === null) return null;
  const digest = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("guided_result_hash_required");
  }
  return digest;
}
