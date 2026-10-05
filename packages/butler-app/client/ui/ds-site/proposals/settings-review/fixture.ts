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
    if (url.pathname === "/credentials") return envelope({ credentials: [] });
    // initialize() sets the draft first, then loads personalization; no page here needs it.
    if (url.pathname === "/personalization") return new Promise<Response>(() => undefined);
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
