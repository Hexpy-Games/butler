import type { ElectronApplication } from "playwright";
import { join, resolve } from "node:path";
import { connectElectronMain } from "./electron-main-cdp";
import { freePort } from "./native-app-server";
import { spawnElectron, stopElectronChild } from "./electron-child";

export type FileElectronApp = Pick<ElectronApplication, "evaluate" | "process" | "close"> & {
  /** An attached main inspector holds a quitting App at exit; the next evaluate reconnects. */
  detach(): void;
};

/** Main inspection without Playwright's piped Electron launcher. */
export async function fileElectronApp(input: {
  executablePath: string; args: string[]; env: NodeJS.ProcessEnv;
  onOutput?: (chunk: Buffer) => void;
}): Promise<FileElectronApp> {
  const port = await freePort();
  const child = spawnElectron(input.executablePath, [`--inspect=${port}`, ...input.args], {
    env: input.env, onOutput: input.onOutput,
  });
  let main: Awaited<ReturnType<typeof connectElectronMain>> | undefined;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      if (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.ok).catch(() => false)) {
        main = await connectElectronMain(port); break;
      }
      await new Promise(done => setTimeout(done, 100));
    }
    if (!main) throw new Error("Electron main inspector unavailable");
    let client: typeof main | undefined = main;
    const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(resolve("packages/butler-app/client/electron"), "package.json"))})('electron')`;
    const evaluate: ElectronApplication["evaluate"] = async (fn: string | ((...args: any[]) => any), arg?: unknown) => (client ??= await connectElectronMain(port)).evaluate<any>(
      typeof fn === "string" ? fn : `(${fn.toString()})(${module},${JSON.stringify(arg) ?? "undefined"})`,
    );
    return {
      evaluate, process: () => child,
      detach() { client?.close(); client = undefined; },
      async close() {
        client?.close(); await stopElectronChild(child);
      },
    };
  } catch (error) { main?.close(); await stopElectronChild(child); throw error; }
}
