import { createHash } from "node:crypto";
import type { FunctionToolDefinition } from "../../../integrations/providers/provider.ts";
import { TOOL_CAPABILITY_METADATA } from "../../tools/registry.ts";
import type { ToolCapabilityMetadata } from "../../tools/types.ts";

export type BtccCapabilityEffect = NonNullable<
  ToolCapabilityMetadata["btcc"]
>["effects"][number];
export type BtccCapabilityPurpose = NonNullable<
  ToolCapabilityMetadata["btcc"]
>["purposes"][number];
export type BtccCapabilityScope = NonNullable<
  ToolCapabilityMetadata["btcc"]
>["scopes"][number];

export interface BtccCapabilityManifestEntry {
  capabilityRef: string;
  effect: BtccCapabilityEffect;
  purposes: BtccCapabilityPurpose[];
  scopes: BtccCapabilityScope[];
  ledgerOperation?: NonNullable<ToolCapabilityMetadata["btcc"]>["ledgerOperation"];
  ledgerRecordKinds?: NonNullable<ToolCapabilityMetadata["btcc"]>["ledgerRecordKinds"];
  declared: boolean;
}

export function btccCapabilityManifestForTool(
  tool: Pick<FunctionToolDefinition, "name" | "parameters">,
): BtccCapabilityManifestEntry[] {
  const declared = TOOL_CAPABILITY_METADATA[tool.name]?.btcc;
  if (!declared) {
    return [{
      capabilityRef: capabilityRef(tool, "external_mutation"),
      effect: "external_mutation",
      purposes: ["execution"],
      scopes: ["external"],
      declared: false,
    }];
  }
  return declared.effects.map((effect) => ({
    capabilityRef: capabilityRef(tool, effect),
    effect,
    purposes: [...declared.purposes],
    scopes: [...declared.scopes],
    ...(declared.ledgerOperation ? { ledgerOperation: declared.ledgerOperation } : {}),
    ...(declared.ledgerRecordKinds?.length
      ? { ledgerRecordKinds: [...declared.ledgerRecordKinds] }
      : {}),
    declared: true,
  }));
}

export function btccCapabilityAllows(input: {
  tool: Pick<FunctionToolDefinition, "name" | "parameters">;
  purpose: BtccCapabilityPurpose;
  effects: readonly BtccCapabilityEffect[];
  scopes?: readonly BtccCapabilityScope[];
  ledgerOperations?: readonly NonNullable<ToolCapabilityMetadata["btcc"]>["ledgerOperation"][];
  ledgerRecordKinds?: readonly ("spec" | "plan" | "work" | "task" | "attempt")[];
  requireDeclared?: boolean;
}): boolean {
  const effects = new Set(input.effects);
  const scopes = input.scopes ? new Set(input.scopes) : null;
  const operations = input.ledgerOperations ? new Set(input.ledgerOperations) : null;
  const recordKinds = input.ledgerRecordKinds ? new Set(input.ledgerRecordKinds) : null;
  return btccCapabilityManifestForTool(input.tool).some((entry) =>
    (input.requireDeclared !== true || entry.declared) &&
    entry.purposes.includes(input.purpose) &&
    effects.has(entry.effect) &&
    (!scopes || entry.scopes.some((scope) => scopes.has(scope))) &&
    (!operations || Boolean(entry.ledgerOperation && operations.has(entry.ledgerOperation))) &&
    (!recordKinds || Boolean(entry.ledgerRecordKinds?.some((kind) => recordKinds.has(kind)))),
  );
}

function capabilityRef(
  tool: Pick<FunctionToolDefinition, "name" | "parameters">,
  effect: BtccCapabilityEffect,
): string {
  return `capability:${createHash("sha256").update(JSON.stringify({
    name: tool.name,
    parameters: tool.parameters,
    effect,
  })).digest("hex").slice(0, 24)}`;
}
