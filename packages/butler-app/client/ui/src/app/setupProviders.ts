import type { FirstRunProviderCardId } from "../../../../../butler-i18n/src/index.ts";
import type { AppModelSummary } from "./types.ts";

export type { FirstRunProviderCardId };

/** How a card connects: browser sign-in, one API key, or Other (a model on this computer or a server address). */
export type ProviderCardKind = "signin" | "key" | "custom";
/** ProviderLogo names used by the cards (a subset of the DS logo set). */
export type ProviderCardLogo = "openai" | "claude" | "anthropic" | "gemini" | "grok" | "qwen" | "kimi" | "zai" | "deepseek" | "upstage" | "opencode" | "ollama" | "lmstudio";

export interface ProviderCardSpec {
  id: FirstRunProviderCardId;
  kind: ProviderCardKind;
  /** Catalog provider id the card connects. */
  providerId?: string;
  logo?: ProviderCardLogo;
  /** Neutral icon when the card has no brand logo. */
  icon?: "server";
  /** The service's own API key page. */
  keyUrl?: string;
}

export const PROVIDER_CARDS: Record<FirstRunProviderCardId, ProviderCardSpec> = {
  chatgpt: { id: "chatgpt", kind: "signin", providerId: "openai", logo: "openai" },
  claude: { id: "claude", kind: "key", providerId: "anthropic", logo: "claude", keyUrl: "https://console.anthropic.com/settings/keys" },
  gemini: { id: "gemini", kind: "key", providerId: "google", logo: "gemini", keyUrl: "https://aistudio.google.com/apikey" },
  openai: { id: "openai", kind: "key", providerId: "openai", logo: "openai", keyUrl: "https://platform.openai.com/api-keys" },
  grok: { id: "grok", kind: "key", providerId: "xai", logo: "grok", keyUrl: "https://console.x.ai" },
  qwen: { id: "qwen", kind: "key", providerId: "qwen", logo: "qwen" },
  kimi: { id: "kimi", kind: "key", providerId: "kimi", logo: "kimi", keyUrl: "https://platform.moonshot.ai/console/api-keys" },
  zaiCoding: { id: "zaiCoding", kind: "key", providerId: "zai", logo: "zai", keyUrl: "https://z.ai/manage-apikey/apikey-list" },
  zaiApi: { id: "zaiApi", kind: "key", providerId: "zai-api", logo: "zai", keyUrl: "https://z.ai/manage-apikey/apikey-list" },
  opencodeGo: { id: "opencodeGo", kind: "key", providerId: "opencode-go", logo: "opencode" },
  other: { id: "other", kind: "custom", providerId: "local", icon: "server" },
};

const PROVIDER_LOGOS: Record<string, ProviderCardLogo> = {
  openai: "openai", anthropic: "claude", google: "gemini", xai: "grok", qwen: "qwen",
  kimi: "kimi", zai: "zai", "zai-api": "zai", deepseek: "deepseek", upstage: "upstage", "opencode-go": "opencode",
};

/** Beside the provider's own name ("Anthropic"), not one of its models ("Claude ..."). */
const PROVIDER_NAME_LOGOS: Record<string, ProviderCardLogo> = { anthropic: "anthropic" };

/** The DS logo of a catalog provider (a local server by its platform), or null for none. */
export function providerLogoName(providerId: string, platform?: string, besideProviderName = false): ProviderCardLogo | null {
  if (providerId === "local") return platform === "ollama" ? "ollama" : platform === "lm_studio" ? "lmstudio" : null;
  return (besideProviderName ? PROVIDER_NAME_LOGOS[providerId] : undefined) ?? PROVIDER_LOGOS[providerId] ?? null;
}

/** The first-run card a connected model came from ("Run setup again" marks it as current). */
export function connectionCardId(
  model: Pick<AppModelSummary, "provider_id" | "auth_type"> | null | undefined,
): FirstRunProviderCardId | null {
  if (!model) return null;
  const { provider_id: providerId, auth_type: authType } = model;
  // Models on this computer and typed servers both come from Other.
  if (providerId === "local") return "other";
  // ChatGPT sign-in and an OpenAI API key are separate cards for one provider.
  if (authType === "chatgpt_oauth") return "chatgpt";
  const card = Object.values(PROVIDER_CARDS).find((spec) => spec.kind === "key" && spec.providerId === providerId);
  return card?.id ?? null;
}

export const TOP_CARD_IDS: readonly FirstRunProviderCardId[] = ["chatgpt", "claude", "gemini"];
export const MORE_CARD_IDS: readonly FirstRunProviderCardId[] = [
  "openai", "grok", "qwen", "kimi", "zaiCoding", "zaiApi", "opencodeGo", "other",
];

/** Card order. Other joins the top cards when a local server answers, so its models stay one click away. */
export function providerCardLayout({ localReachable }: { localReachable: boolean }) {
  return localReachable
    ? { top: [...TOP_CARD_IDS, "other" as const], more: MORE_CARD_IDS.filter((id) => id !== "other") }
    : { top: [...TOP_CARD_IDS], more: [...MORE_CARD_IDS] };
}

/**
 * `GET /setup/local-model-servers` entry (#279; Ollama :11434, LM Studio
 * :1234). `base_url` is the `server_url` a model registers with. The servers
 * state no context window, so registration uses the 16k default.
 */
export interface LocalModelServerView {
  id: "ollama" | "lm_studio" | string;
  label: string;
  base_url: string;
  reachable: boolean;
  models: Array<{ id: string; size_bytes?: number }>;
}

export type LocalModelPlatform = "ollama" | "lm_studio" | "custom";

export interface LocalModelOption {
  key: string;
  modelId: string;
  platform: LocalModelPlatform;
  logo?: ProviderCardLogo;
  serverUrl: string;
  sizeLabel?: string;
  contextWindowTokens?: number;
  /** A model found through a typed server address (Other). */
  sourceModel?: AppModelSummary;
}

function platformOf(serverId: string): { platform: LocalModelPlatform; logo?: ProviderCardLogo } {
  if (serverId === "ollama") return { platform: "ollama", logo: "ollama" };
  if (serverId === "lm_studio") return { platform: "lm_studio", logo: "lmstudio" };
  return { platform: "custom" };
}

function sizeLabel(bytes: number | undefined): string | undefined {
  if (!bytes || bytes <= 0) return undefined;
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Every model of every reachable local server, in server order. */
export function localModelOptions(servers: LocalModelServerView[]): LocalModelOption[] {
  return servers.filter((server) => server.reachable).flatMap((server) => {
    const { platform, logo } = platformOf(server.id);
    return server.models.map((model) => ({
      key: `${server.id}/${model.id}`,
      modelId: model.id,
      platform,
      logo,
      serverUrl: server.base_url,
      sizeLabel: sizeLabel(model.size_bytes),
    }));
  });
}

/** A usable context size, or undefined when unknown (discovery reports 0 when the server gives none). */
export function knownContextWindow(tokens: number | undefined): number | undefined {
  return tokens !== undefined && Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

/** Models found on a typed OpenAI-compatible server (Other). */
export function customModelOptions(serverUrl: string, models: AppModelSummary[]): LocalModelOption[] {
  return models.map((model) => ({
    key: model.model_ref,
    modelId: model.model_id,
    platform: "custom",
    serverUrl,
    contextWindowTokens: knownContextWindow(model.context_window_tokens),
    sourceModel: model,
  }));
}
