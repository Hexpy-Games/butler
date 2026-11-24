import type { AppCopy, FirstRunProviderCardId } from "../../../../../butler-i18n/src/index.ts";
import type { AppModelSummary, ModelCatalogView } from "./types.ts";

export type { FirstRunProviderCardId };
/** A first-run card: a curated slug (`FirstRunProviderCardId`) or, for any other catalog provider, its provider id. */
export type ProviderCardId = FirstRunProviderCardId | (string & {});
/** How a card connects: browser sign-in, one API key, or Other (a model on this computer or a server address). */
export type ProviderCardKind = "signin" | "key" | "custom";
/** ProviderLogo names used by the cards (a subset of the DS logo set). */
export type ProviderCardLogo = "openai" | "claude" | "anthropic" | "gemini" | "grok" | "qwen" | "kimi" | "zai" | "deepseek" | "upstage" | "opencode" | "ollama" | "lmstudio";
/** How a card connects, the catalog provider it connects and the service's own API key page. */
export interface ProviderCard { kind: ProviderCardKind; providerId: string; keyUrl?: string }
/** The curated cards: harness slug, catalog provider and key page. */
const CURATED_CARDS: Record<FirstRunProviderCardId, ProviderCard> = {
  chatgpt: { kind: "signin", providerId: "openai" }, other: { kind: "custom", providerId: "local" },
  claude: { kind: "key", providerId: "anthropic", keyUrl: "https://console.anthropic.com/settings/keys" },
  gemini: { kind: "key", providerId: "google", keyUrl: "https://aistudio.google.com/apikey" },
  openai: { kind: "key", providerId: "openai", keyUrl: "https://platform.openai.com/api-keys" },
  grok: { kind: "key", providerId: "xai", keyUrl: "https://console.x.ai" },
  qwen: { kind: "key", providerId: "qwen" }, opencodeGo: { kind: "key", providerId: "opencode-go" },
  kimi: { kind: "key", providerId: "kimi", keyUrl: "https://platform.moonshot.ai/console/api-keys" },
  zaiCoding: { kind: "key", providerId: "zai", keyUrl: "https://z.ai/manage-apikey/apikey-list" },
  zaiApi: { kind: "key", providerId: "zai-api", keyUrl: "https://z.ai/manage-apikey/apikey-list" },
};
const isCurated = (cardId: string): cardId is FirstRunProviderCardId => Object.hasOwn(CURATED_CARDS, cardId);
/** How a card connects; any other catalog provider's card is its API key (no key page link). */
export const providerCard = (cardId: ProviderCardId): ProviderCard => isCurated(cardId) ? CURATED_CARDS[cardId] : { kind: "key", providerId: cardId };
/** The API key card of a catalog provider: its curated slug, else the provider id. */
export function keyCardId(providerId: string): ProviderCardId {
  return (Object.keys(CURATED_CARDS) as FirstRunProviderCardId[])
    .find((id) => CURATED_CARDS[id].kind === "key" && CURATED_CARDS[id].providerId === providerId) ?? providerId;
}
/** One hosted catalog provider (every provider but "local"; each takes an API key). */
export interface HostedProvider { providerId: string; label: string }
/** The catalog's hosted providers, in catalog order. */
export function hostedProviders(catalog: Pick<ModelCatalogView, "providers">): HostedProvider[] {
  return catalog.providers.filter((entry) => entry.provider_id && entry.provider_id !== "local")
    .map((entry) => ({ providerId: entry.provider_id, label: entry.provider_label }));
}
type CardCopy = Pick<AppCopy["firstRun"], "providerNames" | "providerDescriptions" | "keyLabel">;
/** A card's name: its own copy for a curated card, else the catalog label, else the provider id. */
export function providerCardName(cardId: ProviderCardId, copy: CardCopy, hosted: readonly HostedProvider[]): string {
  return isCurated(cardId) ? copy.providerNames[cardId] : hosted.find((entry) => entry.providerId === cardId)?.label || cardId;
}
/** A card's description: its own words when its key is a different kind (or a top pick), otherwise the plain API key label. */
export function providerCardDescription(cardId: ProviderCardId, copy: CardCopy): string {
  return Object.hasOwn(copy.providerDescriptions, cardId)
    ? copy.providerDescriptions[cardId as keyof CardCopy["providerDescriptions"]] : copy.keyLabel;
}

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
export function connectionCardId(model: Pick<AppModelSummary, "provider_id" | "auth_type"> | null | undefined): ProviderCardId | null {
  if (!model?.provider_id) return null;
  const { provider_id: providerId, auth_type: authType } = model;
  if (providerId === "local") return "other"; // Models on this computer and typed servers both come from Other.
  if (authType === "chatgpt_oauth") return "chatgpt"; // ChatGPT sign-in and an OpenAI API key are separate cards for one provider.
  return keyCardId(providerId);
}
export const TOP_CARD_IDS: readonly ProviderCardId[] = ["chatgpt", "claude", "gemini"];
/** Card order: the top picks, then the other hosted catalog providers in catalog order, then Other. Other joins the top cards when a local server answers, so its models stay one click away. */
export function providerCardLayout({ localReachable, hosted }: { localReachable: boolean; hosted: readonly HostedProvider[] }) {
  const top: ProviderCardId[] = [...TOP_CARD_IDS];
  const more = hosted.map((entry) => keyCardId(entry.providerId)).filter((id) => !top.includes(id));
  return localReachable ? { top: [...top, "other"], more } : { top, more: [...more, "other"] };
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
