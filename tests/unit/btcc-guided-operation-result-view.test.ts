import { expect, test } from "bun:test";
import type { GuidedExactOperationResult } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/guided-work-tool-result-reader.ts";
import {
  GuidedOperationResultViewError,
  selectGuidedOperationResultView,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-operation-result-view.ts";

const exactResult: GuidedExactOperationResult = {
  resultRef: "result:guided-call-1",
  sequence: 3,
  revision: 3,
  sessionId: "session-1",
  scope: { kind: "session", ref: "session-1" },
  toolCallId: "call-1",
  originTurnId: "turn-1",
  toolName: "read_file",
  status: "completed",
  request: {
    path: "src/report.txt",
    expected_sha256: "b".repeat(64),
  },
  result: {
    "a/b": {
      "~key": "decoded",
    },
    text: "alpha\nneedle one\nneedle needle\nomega",
  },
  resultSha256: "a".repeat(64),
};

test("exact result views expose only the three bounded JSON roots", () => {
  expect(view(exactResult, {
    kind: "json_pointer",
    pointer: "/result/a~1b/~0key",
  }).view).toBe("decoded");
  expect(view(exactResult, {
    kind: "json_pointer",
    pointer: "/request/path",
  }).view).toBe("src/report.txt");
  expect(view(exactResult, {
    kind: "json_pointer",
    pointer: "/record/toolName",
  }).view).toBe("read_file");
  const record = view(exactResult, {
    kind: "json_pointer",
    pointer: "/record",
  }).view as Record<string, unknown>;
  expect(record).not.toHaveProperty("request");
  expect(record).not.toHaveProperty("result");

  expectViewError(() => view(exactResult, {
    kind: "json_pointer",
    pointer: "",
  }), "guided_result_view_pointer_required");
  expectViewError(() => view(exactResult, {
    kind: "json_pointer",
    pointer: "/private",
  }), "guided_result_view_pointer_root_invalid");
  expectViewError(() => view(exactResult, {
    kind: "json_pointer",
    pointer: "/result/missing",
  }), "guided_result_view_pointer_missing");
  expectViewError(() => view(exactResult, {
    kind: "json_pointer",
    pointer: "/result/~01",
  }), "guided_result_view_pointer_missing");
});

test("an uncaptured exact result fails honestly at the result root", () => {
  const incompleteResult = { ...exactResult };
  delete incompleteResult.result;

  expectViewError(() => view(incompleteResult, {
    kind: "json_pointer",
    pointer: "/result",
  }), "guided_result_view_capture_incomplete");
  expectViewError(() => view(incompleteResult, {
    kind: "json_pointer",
    pointer: "/result/text",
  }), "guided_result_view_capture_incomplete");
});

test("line ranges are one-based, inclusive, and reject an unbounded end", () => {
  const selected = view(exactResult, {
    kind: "line_range",
    pointer: "/result/text",
    start_line: 2,
    end_line: 3,
  });
  expect(selected.view).toBe("needle one\nneedle needle");

  expectViewError(() => view(exactResult, {
    kind: "line_range",
    pointer: "/result/text",
    start_line: 0,
    end_line: 1,
  }), "guided_result_view_line_range_invalid");
  expectViewError(() => view(exactResult, {
    kind: "line_range",
    pointer: "/result/text",
    start_line: 2,
    end_line: 5,
  }), "guided_result_view_line_range_out_of_bounds");
});

test("byte ranges are exact UTF-8 half-open ranges", () => {
  const text = "A😀éZ";
  const byteStart = Buffer.byteLength("A", "utf8");
  const byteEnd = byteStart + Buffer.byteLength("😀é", "utf8");
  const input: GuidedExactOperationResult = {
    ...exactResult,
    result: { text },
  };

  const selected = view(input, {
    kind: "byte_range",
    pointer: "/result/text",
    start_byte: byteStart,
    end_byte: byteEnd,
  });
  expect(selected.view).toBe("😀é");

  expectViewError(() => view(input, {
    kind: "byte_range",
    pointer: "/result/text",
    start_byte: byteStart + 1,
    end_byte: byteEnd,
  }), "guided_result_view_byte_range_utf8_boundary");
  expectViewError(() => view(input, {
    kind: "byte_range",
    pointer: "/result/text",
    start_byte: 0,
    end_byte: byteEnd + 2,
  }), "guided_result_view_byte_range_out_of_bounds");
});

test("search is literal, bounded by max_matches, and returns reproducible locations", () => {
  const selected = view(exactResult, {
    kind: "search",
    pointer: "/result/text",
    query: "needle",
    max_matches: 2,
  });

  expect(selected.view).toEqual([
    { line: 2, column: 1, snippet: "needle one" },
    { line: 3, column: 1, snippet: "needle needle" },
  ]);

  const literal = view(exactResult, {
    kind: "search",
    pointer: "/result/text",
    query: "[a-z]",
    max_matches: 1,
  });
  expect(literal.view).toEqual([]);

  expectViewError(() => view(exactResult, {
    kind: "search",
    pointer: "/result/text",
    query: "",
    max_matches: 1,
  }), "guided_result_view_search_query_required");
  expectViewError(() => view(exactResult, {
    kind: "search",
    pointer: "/result/text",
    query: "needle",
    max_matches: 0,
  }), "guided_result_view_search_max_matches_invalid");
});

test("maxOutputTokens is a hard tokenBudgetToChars ceiling without truncation", () => {
  expectViewError(() => view(exactResult, {
    kind: "json_pointer",
    pointer: "/result/text",
  }, 1), "guided_result_view_output_budget_exceeded");

  const exact = view(exactResult, {
    kind: "json_pointer",
    pointer: "/result/a~1b/~0key",
  }, 3);
  expect(exact.view).toBe("decoded");
  expect(() => view(exactResult, {
    kind: "json_pointer",
    pointer: "/result/text",
  }, 1)).toThrow(GuidedOperationResultViewError);
  expectViewError(() => view(exactResult, {
    kind: "json_pointer",
    pointer: "/result/text",
  }, 0), "guided_result_view_output_budget_invalid");

  try {
    view(exactResult, {
      kind: "json_pointer",
      pointer: "/result/text",
    }, 1);
  } catch (error) {
    expect(String(error)).not.toContain("PRIVATE_REQUEST_VALUE");
    expect(String(error)).not.toContain("needle one");
  }
});

function view(
  result: GuidedExactOperationResult,
  selector: Parameters<typeof selectGuidedOperationResultView>[0]["selector"],
  maxOutputTokens = 100,
) {
  return selectGuidedOperationResultView({
    result,
    selector,
    maxOutputTokens,
  });
}

function expectViewError(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (error instanceof Error && error.message === `expected ${code}`) throw error;
    expect(error).toBeInstanceOf(GuidedOperationResultViewError);
    expect(error).toMatchObject({ code });
  }
}
