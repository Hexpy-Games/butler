import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectElectronMain } from "../../tests/support/electron-main-cdp.ts";
import { electronPage } from "../../tests/support/electron-page-cdp.ts";
import { freeGatewayPort, freePort, readLocalAuthToken } from "../../tests/support/native-app-server.ts";

export type Api = <T = unknown>(path: string, method?: "GET" | "POST" | "PATCH", body?: unknown) => Promise<T>;
export type App = Awaited<ReturnType<typeof startApp>>;
export type Locale = typeof locales[number];
export const locales = [
  { locale: "ko-KR", language: "ko", theme: "light" },
  { locale: "en-US", language: "en", theme: "dark" },
] as const;

export async function until<T>(read: () => Promise<T | false | null | undefined>, label: string | (() => Promise<string>), timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${typeof label === "string" ? label : await label()}`);
}

export function redact(text: string, token: string | null = null) {
  return (token ? text.replaceAll(token, "[redacted]") : text)
    .replace(/(__o\/)[^/\s"\\]+/gu, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z\d._~+/=-]{32,}/giu, "$1[redacted]");
}

function readLog(path: string) {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
}

const electron = "process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app/package.json')('electron')";
export const windowSetup = `
  const { app, BrowserWindow, screen, nativeImage } = ${electron};
  const win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('app://butler/'));
  if (!win) throw new Error('Main Butler window is missing');
  const browserView = () => win.contentView.children.find(view =>
    view.webContents && !view.webContents.isDestroyed() && view.getVisible() &&
    /^https?:/.test(view.webContents.getURL()) && view.getBounds().width > 0);
`;

export async function startApp(executable: string, data: string, root: string, locale: Locale, out: string, phase: string) {
  const home = join(root, "home");
  const profile = join(root, "electron-profile");
  for (const folder of [home, profile, data]) mkdirSync(folder, { recursive: true });
  const gateway = await freeGatewayPort();
  const inspector = await freePort();
  let debug = await freePort();
  while (debug === inspector) debug = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, BUTLER_HOME: home, BUTLER_DATA: data,
    BUTLER_APP_ELECTRON_USER_DATA_DIR: profile, BUTLER_APP_SERVER_PORT: String(gateway),
    BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_METRICS_ENABLED: "0", BUTLER_APP_WINDOWS_AUTO_UPDATE: "0",
    BUTLER_PROVIDER_QUOTA_POLLING: "0",
  };
  delete env.BUTLER_APP_SERVER_URL;
  delete env.BUTLER_APP_UI_URL;
  const logPath = join(root, "electron.log");
  const fd = openSync(logPath, "a");
  const child = (() => {
    try {
      return spawn(executable, [
        `--lang=${locale.locale}`, `--inspect=${inspector}`, `--remote-debugging-port=${debug}`,
        "--remote-debugging-address=127.0.0.1",
      ], { env, stdio: ["ignore", fd, fd] });
    } finally { closeSync(fd); }
  })();
  const exited = new Promise<void>(done => {
    child.once("exit", () => done());
    child.once("error", () => done());
  });
  const url = `http://127.0.0.1:${gateway}`;
  let token: string | null = null;
  let main: Awaited<ReturnType<typeof connectElectronMain>> | undefined;
  let page: Awaited<ReturnType<typeof electronPage>> | undefined;
  const safe = (text: string) => redact(text, token ?? readLocalAuthToken(data));
  const stop = async () => {
    page?.close();
    try {
      if (child.pid && child.exitCode === null) {
        main ??= await connectElectronMain(inspector).catch(() => undefined);
        await main?.evaluate(`setImmediate(() => ${electron}.app.quit()); true`, false, 2_000).catch(() => {});
      }
    } finally {
      try { await main?.close(); }
      finally {
        try { await waitForExit(exited, child.pid, () => child.exitCode === null && child.signalCode === null); }
        finally {
          for (const [name, path] of [
            ["electron.log", logPath], ["agent.log", join(data, "logs", "butler-agent-app.log")],
          ]) {
            writeFileSync(join(out, name), `\n--- ${phase} ---\n${safe(readLog(path))}`, { flag: "a" });
          }
        }
      }
    }
  };
  try {
    assert(child.pid, "Could not launch Butler.exe");
    main = await until(() => connectElectronMain(inspector).catch(() => null), "Electron main inspector", 60_000);
    page = await electronPage(debug);
    return { main, page, url, safe, stop, ready: () => gatewayReady(url, data, value => { token = value; }) };
  } catch (error) {
    try { throw new Error(safe(String(error)), { cause: error }); }
    finally { await stop(); }
  }
}

async function waitForExit(exited: Promise<void>, pid: number | undefined, alive: () => boolean) {
  async function wait(ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise(done => { timer = setTimeout(done, ms); })]); }
    finally { clearTimeout(timer); }
  }
  await wait(25_000);
  if (!pid || !alive()) return;
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 10_000, windowsHide: true, stdio: "ignore" });
  await wait(5_000);
  assert(!alive(), `Butler PID ${pid} did not exit`);
}

async function gatewayReady(url: string, data: string, saveToken: (token: string) => void): Promise<Api> {
  return until(async () => {
    const token = readLocalAuthToken(data);
    if (!token) return false;
    saveToken(token);
    const api: Api = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
      const response = await fetch(url + path, {
        method, signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}`);
      const envelope = await response.json() as { data: T };
      return envelope.data;
    };
    try {
      if (!(await fetch(url + "/health", { signal: AbortSignal.timeout(5_000), headers: { authorization: `Bearer ${token}` } })).ok) return false;
      const status = await api<{ authenticated_gateway_ready: boolean; btcc_executor_ready: boolean }>("/runtime-readiness");
      return status.authenticated_gateway_ready && status.btcc_executor_ready && api;
    } catch { return false; }
  }, "bundled Agent health and runtime readiness", 120_000);
}
