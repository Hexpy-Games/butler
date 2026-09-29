// The CLI-installed Agent (`butler install` / `butler update`, see
// packages/butler-agent/rust/docs/install-layout.md): AGENT_HOME/current
// names the active version directory. The App runs whichever of its bundled
// Agent and that installation is newer, so an Agent-only update also updates
// the App's service, and a stale CLI install never downgrades the App.
import { constants, accessSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const INSTALL_SCHEMA = "butler.native-agent-install.v1";
const NODE_ARCH = { arm64: "arm64", x64: "x64" };

export function cliAgentHome({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  const configured = env.BUTLER_AGENT_HOME?.trim();
  if (configured && isAbsolute(configured)) return resolve(configured);
  if (platform === "darwin") return join(home, "Applications", "ButlerAgent");
  if (platform === "linux") {
    const xdg = env.XDG_DATA_HOME?.trim();
    const dataHome = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share");
    return join(dataHome, "butler", "agent");
  }
  return null;
}

// The active CLI installation as a launch description, or null when there is
// none or it is not usable on this host.
export function resolveCliInstalledAgent({
  butlerData,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  home = homedir(),
} = {}) {
  const agentHome = cliAgentHome({ platform, env, home });
  if (!agentHome) return null;
  try {
    const root = realpathSync(join(agentHome, "current"));
    const manifest = JSON.parse(readFileSync(join(root, "native-agent-manifest.json"), "utf8"));
    if (manifest.schema !== INSTALL_SCHEMA) return null;
    const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
    if (!version || manifest.platform !== platform || manifest.architecture !== NODE_ARCH[arch]) return null;
    const binary = join(root, "butler-agent");
    const resources = join(root, "resources");
    if (!statSync(binary).isFile() || !existsSync(resources) || !statSync(resources).isDirectory()) return null;
    accessSync(binary, constants.X_OK);
    if (!inside(realpathSync(agentHome), root)) return null;
    return {
      command: binary,
      args: ["--installation-root", root, "--resource-root", resources],
      cwd: butlerData,
      appManaged: true,
      bundledAgentVersion: version,
      env: { BUTLER_DATA: butlerData },
    };
  } catch {
    return null;
  }
}

// The newer of the bundled Agent and the CLI installation. Equal or
// unparseable versions keep the bundled one.
export function preferNewerAgent(bundled, cliInstalled) {
  if (!cliInstalled) return bundled;
  if (!bundled.bundledAgentVersion) return bundled;
  return versionNewer(cliInstalled.bundledAgentVersion, bundled.bundledAgentVersion)
    ? cliInstalled
    : bundled;
}

// Numeric segments of `1.2.3-4`, compared left to right (the Rust CLI's rule).
export function versionNewer(available, current) {
  const parse = (version) => String(version).split(/[.-]/u).map((part) => {
    const digits = /^\d+/u.exec(part)?.[0];
    return digits ? Number.parseInt(digits, 10) : 0;
  });
  const left = parse(available);
  const right = parse(current);
  const length = Math.max(left.length, right.length, 3);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function inside(root, child) {
  const path = relative(root, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}
