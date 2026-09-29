/// <reference types="bun" />
// Shared bun test preload (wired via bunfig.toml [test].preload).
// No test may read or write the owner's real Butler data: a shell that exports
// BUTLER_DATA=~/.butler used to let every Project Ledger fixture land in the
// owner's own ledger. Each test process gets a private HOME, data folder and XDG
// dirs; spawned children inherit them. A test that needs another layout sets its
// own env explicitly.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ISOLATION_ROOT_ENV = "BUTLER_TEST_ROOT";

function isolate(): void {
  const inherited = process.env[ISOLATION_ROOT_ENV];
  if (inherited && existsSync(inherited)) return; // nested bun process: already isolated

  const root = realpathSync(mkdtempSync(join(tmpdir(), "butler-test-")));
  const home = join(root, "home");
  const data = join(root, "data");
  for (const dir of [home, data]) mkdirSync(dir, { recursive: true });
  Object.assign(process.env, {
    [ISOLATION_ROOT_ENV]: root,
    HOME: home,
    USERPROFILE: home,
    BUTLER_DATA: data,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  });
  delete process.env.PROJECT_LEDGER_ROOT;
  delete process.env.PROJECT_LEDGER_REPO;
  delete process.env.BUTLER_PROJECT_LEDGER_REPO;
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
}

type Options = { env?: unknown } & Record<string, unknown>;

// Bun hands children the environment the process started with, not later
// process.env changes, so a spawn without an explicit `env` would escape the
// isolation above. Default every spawn to the live process.env, as Node does.
function spawnWithLiveEnv(): void {
  const childProcess = createRequire(import.meta.url)("node:child_process");
  const withEnv = (options: unknown): Options =>
    options && typeof options === "object" && (options as Options).env
      ? (options as Options)
      : { ...(options as Options | undefined), env: process.env };

  // Node style: (command, args?, options?, callback?); `optionsIndex` says where options sit.
  const patchNode = (name: string, optionsIndex: (args: unknown[]) => number) => {
    const original = childProcess[name];
    childProcess[name] = function (this: unknown, ...args: unknown[]) {
      const at = optionsIndex(args);
      const hasOptions = args[at] !== undefined && typeof args[at] !== "function";
      args.splice(at, hasOptions ? 1 : 0, withEnv(hasOptions ? args[at] : undefined));
      return original.apply(this, args);
    };
  };
  const afterArgs = (args: unknown[]) => (Array.isArray(args[1]) ? 2 : 1);
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) patchNode(name, afterArgs);
  for (const name of ["exec", "execSync"]) patchNode(name, () => 1);

  // Bun style: (cmd[], options?) or ({ cmd, ...options }).
  for (const name of ["spawn", "spawnSync"] as const) {
    const original = Bun[name] as (...args: unknown[]) => unknown;
    (Bun as Record<string, unknown>)[name] = (...args: unknown[]) =>
      Array.isArray(args[0]) ? original(args[0], withEnv(args[1])) : original(withEnv(args[0]));
  }
}

isolate();
spawnWithLiveEnv();
