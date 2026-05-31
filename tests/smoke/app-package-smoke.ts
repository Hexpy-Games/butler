import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/server.ts";

const root = process.cwd();
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const electronRoot = resolve(
  root,
  "packages",
  "butler-app",
  "client",
  "electron",
);
const electronMain = resolve(electronRoot, "main.mjs");
const packagerBin = resolve(
  electronRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-packager.cmd" : "electron-packager",
);
const tempDir = mkdtempSync(join(tmpdir(), "butler-app-package-smoke-"));
const packagedOut = join(tempDir, "packaged");
const packagedArch = process.arch === "arm64" ? "arm64" : "x64";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  assert(
    response.ok,
    `request failed: ${response.status} ${JSON.stringify(body)}`,
  );
  assert(
    body?.protocol_version === "butler.app.v1",
    "invalid app protocol envelope",
  );
  return body.data;
}

assert(
  existsSync(join(uiRoot, "index.html")),
  "Butler app UI dist is missing; run npm --prefix packages/butler-app/client/ui run build first",
);
assert(existsSync(electronMain), "Electron entrypoint is missing");
assert(
  existsSync(packagerBin),
  "Electron packager is missing; run npm --prefix packages/butler-app/client/electron install first",
);

const server = createAppServer({
  dbPath: join(tempDir, "package-smoke.sqlite"),
  butlerData: tempDir,
  uiRoot,
  port: 0,
  bridgeMode: "external",
  responder() {
    return { texts: ["package smoke reply"] };
  },
});

try {
  const health = await readJson(`${server.url}health`);
  assert(health.ok === true, "health did not report ok");

  const settings = await readJson(`${server.url}settings`);
  assert(
    settings.bridge_mode === "external",
    "package smoke should run with external bridge mode",
  );

  const html = await fetch(server.url).then((response) => response.text());
  assert(
    html.includes('<div id="root"></div>'),
    "packaged UI root did not serve",
  );

  const turn = await readJson(`${server.url}messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: "general",
      text: "package smoke",
    }),
  });
  assert(
    turn.reply?.text === "package smoke reply",
    "package smoke message did not round-trip",
  );

  const packageResult = spawnSync(
    packagerBin,
    [
      electronRoot,
      "Butler",
      "--platform=darwin",
      `--arch=${packagedArch}`,
      "--overwrite",
      `--out=${packagedOut}`,
      "--icon=assets/butler.icns",
      "--quiet",
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert(
    packageResult.status === 0,
    `electron package failed: ${packageResult.stderr || packageResult.stdout}`,
  );

  const packageDir = readdirSync(packagedOut).find(
    (entry) => entry === `Butler-darwin-${packagedArch}`,
  );
  assert(packageDir, "packaged app directory was not created");
  const executable = join(
    packagedOut,
    packageDir,
    "Butler.app",
    "Contents",
    "MacOS",
    "Butler",
  );
  assert(existsSync(executable), "packaged app executable was not created");
  assert(
    existsSync(
      join(
        packagedOut,
        packageDir,
        "Butler.app",
        "Contents",
        "Resources",
        "electron.icns",
      ),
    ),
    "packaged app mac icon resource was not created",
  );

  if (process.platform === "darwin") {
    const appProcess = spawn(executable, [], {
      env: {
        ...process.env,
        BUTLER_APP_SERVER_URL: server.url,
        BUTLER_APP_SERVER_BRIDGE: "external",
      },
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert(
        appProcess.exitCode === null,
        "packaged app exited before smoke validation completed",
      );
    } finally {
      appProcess.kill("SIGTERM");
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      service: "butler-app-package-smoke",
      appServerUrl: server.url,
      uiRoot: "packages/butler-app/client/ui/dist",
      packagedApp: `Butler-darwin-${packagedArch}/Butler.app`,
    }),
  );
} finally {
  server.stop();
  rmSync(tempDir, { recursive: true, force: true });
}
