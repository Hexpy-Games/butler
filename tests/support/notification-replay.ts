// Execute the actual Electron preload; capture IPC instead of touching OS state.
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
export async function installNotificationReplay(page: Page, url: string, wallpaperLogFailure = false): Promise<void> {
  await page.addInitScript(({ code, url, wallpaperLogFailure }) => {
    const calls: unknown[] = [];
    const crashes: unknown[] = [];
    const electron = {
      contextBridge: { exposeInMainWorld: (name: string, value: unknown) => Reflect.set(window, name, { ...(value as Record<string, unknown>) }) },
      ipcRenderer: { on: () => {}, removeListener: () => {},
        send: (channel: string) => {
          if (channel === "butler:wallpaper-state" && wallpaperLogFailure) {
            const shared = window as unknown as { __wallpaperLogFailures: number };
            shared.__wallpaperLogFailures++;
            throw new Error("Wallpaper log sink unavailable");
          }
        },
        invoke: async (channel: string, input?: unknown) => {
          if (channel === "butler:ui-crash") { crashes.push(input); return {}; }
          if (channel === "butler:ui-crash-log") return crashes;
          if (channel === "butler:get-server-url") return url;
          if (channel === "butler:get-local-auth-headers") return {};
          if (channel === "butler:show-desktop-notification") { calls.push(input); return { shown: true }; }
          if (channel === "butler-browser:call") return { enabled: false, blocked: false, activeId: null, nativeCovered: false, tabs: [] };
          return {};
        } },
    };
    new Function("require", "process", code)(() => electron, { env: { BUTLER_APP_SERVER_URL: url }, argv: [], platform: "win32" });
    Object.assign(window, { __notifications: calls, __uiCrashes: crashes, __wallpaperLogFailures: 0 });
    const bridge = (window as unknown as { butlerApp: Record<string, unknown> }).butlerApp;
    bridge.subscribeLiveEvents = (_: unknown, handlers: { onEvent: (event: unknown) => void; onOpen?: () => void }) => {
      Object.assign(window, { __emitWorkEvent: handlers.onEvent });
      queueMicrotask(() => handlers.onOpen?.());
      return () => {};
    };
  }, { code: readFileSync("packages/butler-app/client/electron/preload.cjs", "utf8"), url, wallpaperLogFailure });
}
