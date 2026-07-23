import type {
  OperationResultSelector,
  OperationResultView,
} from "../../operation-result/index.ts";
import { OperationPayloadFiles } from "./payload-files.ts";

export function decodeResultSelector(
  input: Record<string, unknown>,
): OperationResultSelector {
  if (input.selector === "bytes") {
    return {
      kind: "bytes",
      start: integer(input.start, 0),
      length: integer(input.length, 1),
    };
  }
  if (input.selector === "lines") {
    return {
      kind: "lines",
      startLine: integer(input.start_line, 1),
      limit: integer(input.limit, 1),
    };
  }
  if (input.selector === "search") {
    return {
      kind: "search",
      query: text(input.query),
      maxMatches: integer(input.max_matches, 1),
    };
  }
  if (input.selector === "json_pointer") {
    return { kind: "json_pointer", pointer: string(input.pointer) };
  }
  throw new Error("Operation result selector is invalid");
}

export function selectOperationResult(input: {
  files: OperationPayloadFiles;
  payloadSha256: string;
  byteLength: number;
  selector: OperationResultSelector;
  jsonDocument?: unknown;
}): OperationResultView {
  if (input.selector.kind === "bytes") {
    const start = Math.min(input.selector.start, input.byteLength);
    const bytes = input.files.readRange(
      input.payloadSha256,
      start,
      input.selector.length,
    );
    return {
      selector: input.selector,
      content: bytes.toString("utf8"),
      byteStart: start,
      byteEnd: start + bytes.byteLength,
      complete: true,
    };
  }

  const content = input.files.readAll(input.payloadSha256).toString("utf8");
  if (input.selector.kind === "lines") {
    const lines = content.split("\n");
    const selected = lines.slice(
      input.selector.startLine - 1,
      input.selector.startLine - 1 + input.selector.limit,
    );
    return {
      selector: input.selector,
      content: selected.join("\n"),
      byteStart: 0,
      byteEnd: input.byteLength,
      complete: true,
    };
  }
  if (input.selector.kind === "search") {
    const selector = input.selector;
    const candidates = content.split("\n")
      .map((line, index) => ({ line: index + 1, content: line }))
      .filter((line) => line.content.includes(selector.query))
      .slice(0, selector.maxMatches + 1);
    const complete = candidates.length <= selector.maxMatches;
    return {
      selector,
      content: JSON.stringify(candidates.slice(0, selector.maxMatches)),
      byteStart: 0,
      byteEnd: input.byteLength,
      complete,
    };
  }
  return {
    selector: input.selector,
    content: JSON.stringify(
      readJsonPointer(
        input.jsonDocument ?? JSON.parse(content),
        input.selector.pointer,
      ),
    ),
    byteStart: 0,
    byteEnd: input.byteLength,
    complete: true,
  };
}

function readJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) throw new Error("JSON pointer must start with /");
  return pointer.slice(1).split("/").reduce((current, token) => {
    if (!current || typeof current !== "object") {
      throw new Error("JSON pointer does not resolve");
    }
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!(key in current)) throw new Error("JSON pointer does not resolve");
    return (current as Record<string, unknown>)[key];
  }, value);
}

function integer(value: unknown, minimum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new Error("Operation result selector integer is invalid");
  }
  return Number(value);
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("Operation result selector text is invalid");
  }
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Operation result selector text is invalid");
  }
  return value;
}
