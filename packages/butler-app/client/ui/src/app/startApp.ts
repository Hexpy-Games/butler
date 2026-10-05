import { bindAppMotion } from "./appMotion";
import { loadStartupSettings } from "./startupSettings";
import { useButlerStore } from "./store";

/** Render cached appearance immediately, then reconcile the authoritative snapshot. */
export async function startApp(render: () => void, visualMode: string | null): Promise<void> {
  if (!visualMode) bindAppMotion();
  render();
  if (!visualMode && !window.butlerApp?.startupIssue) {
    void loadStartupSettings().then((settings) => useButlerStore.getState().setSettings(settings), () => undefined);
  }
}
