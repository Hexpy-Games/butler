// Execute the actual Electron preload; capture IPC instead of touching OS state.
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
export async function installNotificationReplay(page: Page, url: string): Promise<void> {
  await page.addInitScript(({ code, url }) => {
    const calls: unknown[] = [];
    const electron = {
      contextBridge: { exposeInMainWorld: (name: string, value: unknown) => Reflect.set(window, name, { ...(value as Record<string, unknown>) }) },
      ipcRenderer: { on: () => {}, removeListener: () => {},
        invoke: async (channel: string, input?: unknown) => {
          if (channel === "butler:get-server-url") return url;
          if (channel === "butler:get-local-auth-headers") return {};
          if (channel === "butler:show-desktop-notification") { calls.push(input); return { shown: true }; }
          return {};
        } },
    };
    new Function("require", "process", code)(() => electron, { env: { BUTLER_APP_SERVER_URL: url }, argv: [], platform: "win32" });
    Object.assign(window, { __notifications: calls });
    const bridge = (window as unknown as { butlerApp: Record<string, unknown> }).butlerApp;
    bridge.subscribeLiveEvents = (_: unknown, handlers: { onEvent: (event: unknown) => void; onOpen?: () => void }) => {
      Object.assign(window, { __emitWorkEvent: handlers.onEvent });
      queueMicrotask(() => handlers.onOpen?.());
      return () => {};
    };
  }, { code: readFileSync("packages/butler-app/client/electron/preload.cjs", "utf8"), url });
}
