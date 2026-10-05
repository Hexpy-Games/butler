import { EMPTY_SETTINGS } from "@/app/constants";
import { setAppCopyLanguage } from "@/app/copy";
import { HARNESS_MODEL_CATALOG } from "@/app/fixtures";
import { useButlerStore } from "@/app/store";
import type { SettingsView } from "@/app/types";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import type { ProposalLocale } from "./state";

// Proposal-only fixture: the real app and settings stores with an in-memory gateway, so the real
// Settings shell, sidebar, header and fields render without a backend. Nothing is persisted.

export function proposalSettings(locale: ProposalLocale, theme: "light" | "dark", reduceMotion = false): SettingsView {
  return {
    ...EMPTY_SETTINGS,
    language: locale === "ko-KR" ? "ko" : "en",
    appearance_theme: theme,
    // Proposed field (codex/reduce-motion); read by the proposal's Appearance copy only.
    ...({ reduce_motion: reduceMotion } as object),
  };
}

const SECURITY = {
  remote_access_enabled: true, bind_addresses: ["127.0.0.1:7777", "192.168.1.20:7777"],
  lan_urls: ["http://192.168.1.20:7777"], allowed_hosts: ["butler.example.ts.net"],
};
const DEVICES = [{ id: "device-1", name: "iPhone", ip: "192.168.1.31", created_at: 1_790_000_000, last_seen_at: 1_791_150_000 }];
const CREDENTIALS = {
  credentials: [{
    id: "openai-1", provider_id: "openai", auth_type: "api_key", label: "OpenAI", masked_value: "sk-…4f2a",
    storage: "keychain", created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z", model_refs: [],
  }],
  store: { backend: "keychain", reason: "signed_build", override_ignored: false, legacy_plaintext: 0 },
};

function envelope(data: unknown, status = 200): Response {
  return Response.json(status < 400 ? { data } : { error: data }, { status });
}

/** Installs the in-memory gateway; returns a restore function. */
export function installSettingsFixture(locale: ProposalLocale, theme: "light" | "dark"): () => void {
  const originalFetch = window.fetch;
  const app = useButlerStore.getState();
  const settingsUI = useSettingsUIStore.getState();
  let settings = proposalSettings(locale, theme);
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/settings" && method === "PATCH") {
      settings = { ...settings, ...JSON.parse(String(init?.body ?? "{}")) };
      return envelope(settings);
    }
    if (url.pathname === "/settings") return envelope(settings);
    if (url.pathname === "/wallpapers") return envelope({ wallpapers: [] });
    if (url.pathname === "/wallpaper-modules") return envelope({ modules: [] });
    if (url.pathname === "/credentials") return envelope(CREDENTIALS);
    if (url.pathname === "/security") return envelope(SECURITY);
    if (url.pathname === "/security/pairing") return envelope(null);
    if (url.pathname === "/security/devices") return envelope(DEVICES);
    // initialize() sets the draft first, then loads personalization; no page here needs it.
    if (url.pathname === "/personalization") return new Promise<Response>(() => undefined);
    // The shell mock's conversation: its controls stay loading (no composer change is reviewed).
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return new Promise<Response>(() => undefined);
    if (url.origin === location.origin && !url.pathname.includes(".")) return envelope({ code: "not_found", message: "" }, 404);
    return originalFetch(input, init);
  }, originalFetch);
  setAppCopyLanguage(locale);
  // The product visual harness's model catalog, so the real Models sections render as they do there.
  useButlerStore.setState({ settings, modelCatalog: HARNESS_MODEL_CATALOG });
  void useSettingsUIStore.getState().initialize(settings, "appearance");
  return () => {
    window.fetch = originalFetch;
    useButlerStore.setState(app, true);
    useSettingsUIStore.setState(settingsUI, true);
  };
}
