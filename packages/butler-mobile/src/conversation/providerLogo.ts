import type { ProviderLogoName } from "../ds/internal/providerLogoXml";

const PROVIDER_LOGOS: Record<string, ProviderLogoName> = {
  openai: "openai", anthropic: "claude", google: "gemini", xai: "grok", qwen: "qwen",
  kimi: "kimi", zai: "zai", "zai-api": "zai", deepseek: "deepseek", upstage: "upstage", "opencode-go": "opencode",
};

/** The DS logo of a catalog provider (a local server by its platform), or null for none. */
export function providerLogoName(providerId: string, platform?: string): ProviderLogoName | null {
  if (providerId === "local") return platform === "ollama" ? "ollama" : platform === "lm_studio" ? "lmstudio" : null;
  return PROVIDER_LOGOS[providerId] ?? null;
}
