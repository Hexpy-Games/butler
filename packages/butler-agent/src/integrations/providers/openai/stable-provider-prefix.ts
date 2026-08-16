import { createHash } from "node:crypto";
import type {
  ModelRouteRequestContext,
  ProviderRouteCacheIdentity,
  StableProviderCachePrefixContract,
} from "../../../agent/btcc/ports/model-round.ts";
import { stableProviderPrefixInvariant } from
  "../../../agent/btcc/ports/model-round.ts";
import type { OpenAIAuthMode } from "./auth.ts";

export type OpenAISerializerContract =
  | "butler.openai-responses-final-json.v1"
  | "butler.openai-codex-final-json.v1";

export function stableProviderOrderedBody(input: {
  stable: StableProviderCachePrefixContract;
  model: string;
  tools?: unknown;
  toolChoice: unknown;
  reasoning: unknown;
  instructions: string | undefined;
  dynamic: Record<string, unknown>;
}): Record<string, unknown> {
  if (input.stable.schemaVersion !== "butler.stable-provider-cache-prefix.v1" ||
      !boundedRevision(input.stable.stablePrefixRevision) ||
      !boundedRevision(input.stable.toolProfileRevision) ||
      input.stable.instructionPrefix.length === 0 ||
      Buffer.byteLength(input.stable.instructionPrefix, "utf8") > 200_000) {
    throw stableProviderPrefixInvariant("stable_provider_prefix_contract_invalid");
  }
  if (!input.instructions?.startsWith(input.stable.instructionPrefix)) {
    throw stableProviderPrefixInvariant("stable_provider_prefix_instruction_mismatch");
  }
  if (["model", "tools", "tool_choice", "reasoning", "instructions"]
      .some((key) => Object.hasOwn(input.dynamic, key))) {
    throw stableProviderPrefixInvariant("stable_provider_prefix_dynamic_collision");
  }
  return {
    model: input.model,
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    tool_choice: input.toolChoice,
    reasoning: input.reasoning,
    instructions: input.instructions,
    ...input.dynamic,
  };
}

export function establishFinalProviderCacheIdentity(input: {
  body: Record<string, unknown>;
  serializedBody: string;
  stable: StableProviderCachePrefixContract;
  route: ModelRouteRequestContext | undefined;
  providerId: ProviderRouteCacheIdentity["providerId"];
  authMode: OpenAIAuthMode;
  serializerContract: OpenAISerializerContract;
  previousIdentity?: unknown;
}): { identity: ProviderRouteCacheIdentity; serializedStablePrefix: string } {
  const route = input.route;
  if (!route) throw stableProviderPrefixInvariant("stable_provider_prefix_route_context_missing");
  if (route.schemaVersion !== "butler.model-route-request.v1" ||
      route.modelRef.trim().length === 0 || route.modelRef.length > 200 || route.cursor < 0 ||
      !Number.isSafeInteger(route.cursor) || !/^[a-f0-9]{64}$/u.test(route.routeDigest) ||
      (route.toolSurfaceDigest !== undefined &&
        !/^[a-f0-9]{64}$/u.test(route.toolSurfaceDigest))) {
    throw stableProviderPrefixInvariant("stable_provider_prefix_route_context_invalid");
  }
  const bodyInstructions = input.body.instructions;
  if (typeof bodyInstructions !== "string" ||
      !bodyInstructions.startsWith(input.stable.instructionPrefix)) {
    throw stableProviderPrefixInvariant("stable_provider_prefix_instruction_mismatch");
  }
  const prefixBody: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.body)) {
    prefixBody[key] = key === "instructions"
      ? input.stable.instructionPrefix
      : value;
    if (key === "instructions") break;
  }
  const encodedPrefixBody = JSON.stringify(prefixBody);
  const instruction = JSON.stringify(input.stable.instructionPrefix);
  const suffix = `${instruction}}`;
  if (!encodedPrefixBody.endsWith(suffix)) {
    throw stableProviderPrefixInvariant("stable_provider_prefix_serializer_order_invalid");
  }
  const serializedStablePrefix = encodedPrefixBody.slice(0, -2);
  if (!input.serializedBody.startsWith(serializedStablePrefix)) {
    throw stableProviderPrefixInvariant("stable_provider_prefix_final_bytes_mismatch");
  }
  const capabilityDigest = sha256(JSON.stringify(input.body.tools ?? []));
  const identity: ProviderRouteCacheIdentity = {
    schemaVersion: "butler.provider-route-cache-identity.v1",
    routeDigest: route.routeDigest,
    routeCursor: route.cursor,
    providerId: input.providerId,
    modelRef: String(input.body.model ?? route.modelRef),
    authMode: input.authMode,
    capabilityDigest,
    ...(route.toolSurfaceDigest
      ? { toolSurfaceDigest: route.toolSurfaceDigest }
      : {}),
    serializerContract: input.serializerContract,
    toolProfileRevision: input.stable.toolProfileRevision,
    stablePrefixRevision: input.stable.stablePrefixRevision,
    serializedStablePrefixSha256: sha256(serializedStablePrefix),
    serializedStablePrefixBytes: Buffer.byteLength(serializedStablePrefix, "utf8"),
  };
  if (input.previousIdentity !== undefined &&
      JSON.stringify(input.previousIdentity) !== JSON.stringify(identity)) {
    throw stableProviderPrefixInvariant("stable_provider_prefix_route_identity_mismatch");
  }
  return { identity, serializedStablePrefix };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedRevision(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,119}$/u.test(value);
}
