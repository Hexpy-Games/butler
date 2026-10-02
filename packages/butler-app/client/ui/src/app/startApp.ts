import { bindAppMotion } from "./appMotion";
import { loadStartupSettings } from "./startupSettings";
import { useButlerStore } from "./store";

/** Load saved appearance before mounting animated UI, including with an empty cache. */
export async function startApp(render: () => void, visualMode: string | null): Promise<void> {
  if (!visualMode && !window.butlerApp?.startupIssue) {
    await loadStartupSettings().then((settings) => useButlerStore.getState().setSettings(settings), () => undefined);
  }
  // On connection failure the existing onboarding gate recovers from the cached setting.
  if (!visualMode) bindAppMotion();
  render();
}
