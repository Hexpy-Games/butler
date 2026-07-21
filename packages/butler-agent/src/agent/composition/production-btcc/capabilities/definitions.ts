import type { ProductionCapability } from "./contracts.ts";
import { executeFileCapability } from "./file-capabilities.ts";
import { executeCommandCapability } from "./command-capability.ts";
import { executeWebCapability } from "./web-capabilities.ts";

const object = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const integer = (minimum?: number, maximum?: number) => ({
  type: "integer",
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});
const strings = () => ({ type: "array", items: { type: "string" } });

export const PRODUCTION_CAPABILITIES: readonly ProductionCapability[] = [
  {
    capabilityRef: "read_file",
    name: "read_file",
    description: "Read bounded UTF-8 text inside the admitted workspace.",
    operationKinds: ["observe", "review_validation"],
    inputSchema: object({
      path: string("Workspace-relative path."),
      start_line: integer(1),
      limit_lines: integer(1, 10_000),
      max_bytes: integer(1, 1_048_576),
    }, ["path"]),
    execute: (args, context) => executeFileCapability("read_file", args, context),
  },
  {
    capabilityRef: "write_file",
    name: "write_file",
    description: "Atomically create or replace UTF-8 text inside an isolated workspace.",
    operationKinds: ["workspace_artifact_action"],
    inputSchema: object({
      path: string("Workspace-relative path."),
      content: string(),
      overwrite: { type: "boolean" },
      expected_sha256: string(),
      create_parents: { type: "boolean" },
    }, ["path", "content", "overwrite"]),
    execute: (args, context) => executeFileCapability("write_file", args, context),
  },
  {
    capabilityRef: "grep_files",
    name: "grep_files",
    description: "Search bounded workspace text in deterministic source-first order.",
    operationKinds: ["observe", "review_validation"],
    inputSchema: object({
      pattern: string(),
      regex: { type: "boolean" },
      case_sensitive: { type: "boolean" },
      include: strings(),
      exclude: strings(),
      context: integer(0, 10),
      max_matches: integer(1, 1_000),
    }, ["pattern"]),
    execute: (args, context) => executeFileCapability("grep_files", args, context),
  },
  {
    capabilityRef: "run_command",
    name: "run_command",
    description: "Run one non-interactive command inside an isolated workspace.",
    operationKinds: ["workspace_artifact_action", "review_validation"],
    inputSchema: object({
      command: string(),
      cwd: string(),
      timeout_ms: integer(1, 600_000),
      max_output_tokens: integer(1, 100_000),
    }, ["command"]),
    execute: executeCommandCapability,
  },
  {
    capabilityRef: "web_search",
    name: "web_search",
    description: "Search the public web for current or external information.",
    operationKinds: ["observe"],
    inputSchema: object({
      query: string(),
      allowed_domains: strings(),
      blocked_domains: strings(),
      recency_days: integer(1),
      max_results: integer(1, 10),
    }, ["query"]),
    execute: (args, context) => executeWebCapability("web_search", args, context),
  },
  {
    capabilityRef: "web_read",
    name: "web_read",
    description: "Read a bounded public http(s) page.",
    operationKinds: ["observe"],
    inputSchema: object({
      url: string(),
      max_chars: integer(500, 8_000),
      backend: {
        type: "string",
        enum: ["auto", "lightpanda", "lightweight", "jina-hosted", "disabled"],
      },
    }, ["url"]),
    execute: (args, context) => executeWebCapability("web_read", args, context),
  },
];
