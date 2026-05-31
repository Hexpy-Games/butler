export interface ParsedModelRef {
  input: string;
  canonicalRef: string;
  providerId: string;
  modelId: string;
  source: "namespaced" | "legacy-alias" | "raw-model-id";
}

function trimToUndefined(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function looksLikeOpenAIModel(value: string): boolean {
  return /^gpt-[a-z0-9.-]+$/i.test(value) || /^o[1-9]/i.test(value);
}

export function parseModelRef(input: string): ParsedModelRef {
  const trimmed = trimToUndefined(input) ?? "";
  const namespaced = /^([^/\s]+)\/([^/\s].*)$/.exec(trimmed);
  if (namespaced) {
    return {
      input: trimmed,
      canonicalRef: `${namespaced[1]}/${namespaced[2]}`,
      providerId: namespaced[1]!,
      modelId: namespaced[2]!,
      source: "namespaced",
    };
  }

  const providerId = looksLikeOpenAIModel(trimmed) ? "openai" : "custom";
  return {
    input: trimmed,
    canonicalRef: `${providerId}/${trimmed}`,
    providerId,
    modelId: trimmed,
    source: "raw-model-id",
  };
}
