import { digest, stableJson } from "../identity/index.ts";
import type { BtccAgentLoopToolDefinition } from "./contracts.ts";
import { RoundToolSurfaceError } from "../ports/model-round.ts";

export type BtccRoundToolSurfaceSnapshot = {
  readonly tools: readonly BtccAgentLoopToolDefinition[];
  readonly names: BtccRoundToolNameSet;
  readonly digest: string;
};

type BtccRoundToolNameSet = Iterable<string> & {
  readonly size: number;
  has(value: string): boolean;
};

export function createRoundToolSurfaceSnapshot(
  tools: readonly BtccAgentLoopToolDefinition[],
): BtccRoundToolSurfaceSnapshot {
  const snapshotTools = Object.freeze(tools.map(freezeTool));
  const names = new ImmutableNameSet(snapshotTools.map((tool) => tool.name));
  if (names.size !== snapshotTools.length) {
    throw new RoundToolSurfaceError("round_tool_surface_duplicate_name");
  }
  return Object.freeze({
    tools: snapshotTools,
    names,
    digest: digest(stableJson(snapshotTools)),
  });
}

export function assertRoundToolSurfaceSnapshot(
  value: BtccRoundToolSurfaceSnapshot,
): BtccRoundToolSurfaceSnapshot {
  if (!value || typeof value !== "object" ||
      !Array.isArray(value.tools) || !(value.names instanceof ImmutableNameSet) ||
      typeof value.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.digest)) {
    throw new RoundToolSurfaceError("round_tool_surface_invalid_snapshot");
  }
  const canonical = createRoundToolSurfaceSnapshot(value.tools);
  if (value.names.size !== canonical.names.size ||
      [...canonical.names].some((name) => !value.names.has(name)) ||
      canonical.digest !== value.digest) {
    throw new RoundToolSurfaceError("round_tool_surface_snapshot_mismatch");
  }
  return canonical;
}

export async function resolveRoundToolSurface(
  resolver: (() => BtccRoundToolSurfaceSnapshot | Promise<BtccRoundToolSurfaceSnapshot>) |
    undefined,
  fallback: readonly BtccAgentLoopToolDefinition[],
): Promise<{ tools: readonly BtccAgentLoopToolDefinition[]; toolSurfaceDigest?: string }> {
  if (!resolver) return { tools: fallback };
  const snapshot = assertRoundToolSurfaceSnapshot(await resolver());
  return { tools: snapshot.tools, toolSurfaceDigest: snapshot.digest };
}

export function finalRoundToolSurface(
  tools: readonly BtccAgentLoopToolDefinition[],
  identified: boolean,
): { tools: readonly BtccAgentLoopToolDefinition[]; toolSurfaceDigest?: string } {
  return identified
    ? { tools, toolSurfaceDigest: createRoundToolSurfaceSnapshot(tools).digest }
    : { tools };
}

function freezeTool(tool: BtccAgentLoopToolDefinition): BtccAgentLoopToolDefinition {
  if (!tool || typeof tool.name !== "string" || tool.name.length === 0 ||
      typeof tool.description !== "string" || !isRecord(tool.parameters)) {
    throw new RoundToolSurfaceError("round_tool_surface_invalid_tool");
  }
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    parameters: freezeJson(tool.parameters) as Record<string, unknown>,
    ...(tool.concurrencySafe === undefined
      ? {}
      : { concurrencySafe: tool.concurrencySafe }),
  });
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (isRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, freezeJson(child)]),
    ));
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  throw new RoundToolSurfaceError("round_tool_surface_invalid_tool");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ImmutableNameSet implements BtccRoundToolNameSet {
  readonly #values: Set<string>;

  constructor(values: Iterable<string>) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: string): boolean {
    return this.#values.has(value);
  }

  values(): SetIterator<string> {
    return this.#values.values();
  }

  [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }
}
