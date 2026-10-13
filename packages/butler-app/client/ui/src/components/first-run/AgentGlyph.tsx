import { Bot, ProviderLogo, type ProviderLogoName } from "@/butler-ds";

const LOGOS: Record<string, ProviderLogoName> = { "claude-code": "claude", codex: "openai", opencode: "opencode" };

/** The brand logo of an AI tool Butler imports from, or the neutral bot icon. */
export function AgentGlyph({ sourceKey }: { sourceKey: string }) {
  const logo = LOGOS[sourceKey];
  return logo ? <ProviderLogo name={logo} /> : <Bot size="md" />;
}
