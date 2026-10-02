//! INS-15 — the App launches the newer of its bundled Agent and the one the
//! CLI installed: the App's own resolver (`bundled-native-agent.mjs`, run by
//! Node) reads an Agent home that `butler install` wrote. Skipped where Node
//! is not installed.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

mod install_support;

use std::fs;
use std::path::Path;
use std::process::Command;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::binary::workspace_root;
use butler_e2e::e2e::install_fixture::build_stub_archive;
use install_support::{ok, run, sandbox};

/// Resolves the packaged App's Agent for a bundled payload of `bundled`, with
/// `agent_home` as the CLI's Agent home; the version it picks, or `None`
/// without Node.
fn app_picks(root: &Path, agent_home: &Path, bundled: &str) -> Option<String> {
    let module = workspace_root().join("../../butler-app/client/electron/bundled-native-agent.mjs");
    let script = r##"
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [module, root, agentHome, bundled] = process.argv.slice(1);
const darwin = process.platform === "darwin";
const app = join(root, darwin ? "Butler.app" : "app");
const resourcesPath = join(app, darwin ? "Contents/Resources" : "resources");
const execPath = join(app, darwin ? "Contents/MacOS/Butler" : "Butler");
const payload = join(resourcesPath, "bundled-agent");
mkdirSync(join(payload, "bin"), { recursive: true });
mkdirSync(join(payload, "resources"), { recursive: true });
writeFileSync(join(payload, "bin/butler-agent"), "#!/bin/sh\n");
chmodSync(join(payload, "bin/butler-agent"), 0o755);
writeFileSync(join(payload, "native-agent-manifest.json"), JSON.stringify({ version: bundled }));
const { resolveNativeAgentInstallation } = await import(pathToFileURL(module).href);
const chosen = resolveNativeAgentInstallation({
  butlerData: join(root, "data"), resourcesPath, execPath,
  platform: process.platform, isPackaged: true, env: { BUTLER_AGENT_HOME: agentHome },
});
console.log(JSON.stringify({ version: chosen.bundledAgentVersion, command: chosen.command }));
"##;
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script, "--"])
        .arg(&module)
        .arg(root)
        .arg(agent_home)
        .arg(bundled)
        .output()
        .ok()?;
    assert!(
        output.status.success(),
        "node failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let chosen: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    chosen["version"].as_str().map(str::to_owned)
}

#[test]
fn ins_15_the_app_runs_the_newer_of_its_bundled_and_the_installed_agent() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("SKIPPED (node is not installed)");
        return Ok(());
    }
    let (mut sandbox, launch) = sandbox("INS-15")?;
    let home = sandbox.root.join("agent-home");
    let install = |version: &str| -> Result<(), HarnessError> {
        let archive = build_stub_archive(&sandbox.root.join("fixtures"), version, "app")?;
        ok(&run(launch.command().args([
            "install",
            "--from",
            &archive.path.display().to_string(),
            "--no-restart",
            "--json",
        ]))?)?;
        Ok(())
    };
    let app_root = sandbox.root.join("app-root");
    fs::create_dir_all(&app_root)?;

    // Nothing installed: the bundled Agent.
    assert_eq!(
        app_picks(&app_root, &home, "0.0.21").as_deref(),
        Some("0.0.21")
    );
    // Installed but older: still the bundled one.
    install("0.0.20")?;
    assert_eq!(
        app_picks(&app_root, &home, "0.0.21").as_deref(),
        Some("0.0.21")
    );
    // Installed and newer: the installed one.
    install("0.0.22")?;
    assert_eq!(
        app_picks(&app_root, &home, "0.0.21").as_deref(),
        Some("0.0.22")
    );
    // And back: after a rollback to the older one, the bundled Agent wins.
    ok(&run(launch.command().args([
        "rollback",
        "--to",
        "0.0.20",
        "--yes",
        "--no-restart",
        "--json",
    ]))?)?;
    assert_eq!(
        app_picks(&app_root, &home, "0.0.21").as_deref(),
        Some("0.0.21")
    );
    sandbox.mark_success();
    Ok(())
}
