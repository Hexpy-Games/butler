/** Shared Squirrel release checksums and the deployed Agent manifest contract. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeWindowsReleaseOutputs(out: string, version: string, baseUrl: string): string[] {
  const files = readdirSync(out).filter(name => name === "RELEASES" || /\.(exe|nupkg|zip)$/u.test(name));
  const digests = new Map<string, string>();
  for (const name of files) {
    const digest = createHash("sha256").update(readFileSync(join(out, name))).digest("hex");
    digests.set(name, digest);
    writeFileSync(join(out, `${name}.sha256`), `${digest}  ${name}\n`);
  }
  const packages = files.filter(name => name.endsWith("-full.nupkg"));
  if (packages.length !== 1) throw new Error("Expected one selected full nupkg");
  const name = packages[0]!;
  writeFileSync(join(out, "app-update-manifest.json"), JSON.stringify({
    app_version: version, bundled_agent_version: version, artifacts: [{
      component: "app", product: "butler-app", platform: "windows-x64", version,
      app_version: version, bundled_agent_version: version, channel: version.includes("-") ? "preview" : "stable",
      artifact_url: `${baseUrl}/${name}`, sha256: digests.get(name), package_format: "nupkg",
      payload_format: "platform-app-package", update_policy: "app-user-action", restart_policy: "restart-app",
      updater_owner: "butler-app", staging_policy: "butler-data-updates",
      activation_policy: "user-installs-app-package", rollback_policy: "not-managed-by-butler",
    }],
  }, null, 2) + "\n");
  return files;
}
