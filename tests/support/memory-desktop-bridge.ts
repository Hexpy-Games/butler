import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server";

/** Keep the real preload fetch contract in the populated Memory smoke. */
export async function installMemoryDesktopBridge(page: Page, server: NativeAppServerHandle) {
  const code = readFileSync("packages/butler-app/client/electron/preload.cjs", "utf8");
  await page.evaluate(({ code, url, headers }) => {
    const ipcRenderer = {
      invoke: async (channel: string) => channel === "butler:get-server-url" ? url
        : channel === "butler:get-local-auth-headers" ? headers : null,
      on() {}, removeListener() {},
    };
    const contextBridge = { exposeInMainWorld(name: string, value: unknown) {
      if (name === "butlerApp") Object.assign(window, { butlerApp: value });
    } };
    new Function("require", "process", code)(() => ({ contextBridge, ipcRenderer }), {
      env: { BUTLER_APP_SERVER_URL: url }, argv: [], platform: "darwin",
    });
  }, { code, url: server.url, headers: server.authHeaders });
}

export async function assertPopulatedMemorySections(page: Page) {
  const instructions = page.locator('[data-settings-section-id="instructions"]');
  await instructions.locator('[data-test-class="instruction-row"]').nth(2).waitFor();
  const project = page.locator('[data-settings-section-id="project-memory"]');
  await project.getByText("butler-site", { exact: true }).waitFor();
  await project.getByText("212", { exact: true }).waitFor();
  await project.getByText("1", { exact: true }).waitFor();
  if (await instructions.locator('[data-test-class="instruction-row"]').count() !== 3) {
    throw new Error("Desktop bridge must render every instruction");
  }
  await project.getByRole("button", { name: /^(Reset|초기화)$/u, exact: true }).waitFor();
  if (!(await project.getByRole("button", { name: /^(Reset|초기화)$/u }).isEnabled())) {
    throw new Error("Non-empty project memory must finish loading over the desktop bridge");
  }
}
