//! Owner-approved public CLI and removed operator commands.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::Setup;

#[test]
fn cli_surface_exposes_only_user_commands() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("CLI-SLIM")?;
    let launch = butler_e2e::e2e::agent::Launch::new(&setup.sandbox)?;
    let version = launch.command().args(["--version", "--json"]).output()?;
    assert!(version.status.success());
    let version: serde_json::Value = serde_json::from_slice(&version.stdout)?;
    assert_eq!(version["command"], "butler version");
    let output = launch.command().args(["--help", "--json"]).output()?;
    assert!(output.status.success());
    let help: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let entries = help["data"]["commands"].as_array().unwrap();
    let actual = entries
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    let expected = [
        "install",
        "start",
        "stop",
        "restart",
        "status",
        "open",
        "remote.status",
        "remote.enable",
        "remote.disable",
        "remote.pair",
        "remote.devices",
        "remote.hosts.add",
        "remote.hosts.remove",
        "doctor",
        "update",
        "rollback",
        "uninstall",
        "startup.enable",
        "startup.disable",
        "startup.status",
        "auth.login",
        "auth.logout",
        "auth.status",
        "model.list",
        "model.status",
        "model.set",
        "logs",
        "schedule.list",
        "schedule.show",
        "schedule.create",
        "schedule.update",
        "schedule.run",
        "schedule.delete",
        "mcp.list",
        "mcp.add",
        "mcp.enable",
        "mcp.disable",
        "mcp.delete",
        "mcp.test",
        "skills.list",
        "skills.import",
        "config.get",
        "config.set",
        "help",
        "version",
    ];
    assert_eq!(actual, expected);
    let usage = help["data"]["usage"].as_str().unwrap();
    assert!(usage.contains("예약 작업") && usage.contains("schedule"));
    assert!(usage.contains("npx @hexpygames/butler install"));
    for args in [
        vec!["context", "status"],
        vec!["maintenance", "context"],
        vec!["conversation", "historical-recovery", "--write"],
        vec!["cognition", "memory", "status"],
        vec!["cog", "memory", "status"],
        vec!["work", "list"],
        vec!["transport", "status"],
        vec!["metrics", "status"],
        vec!["ps"],
        vec!["personalization", "set", "name", "x"],
        vec!["search", "status"],
        vec!["web", "read", "https://example.com"],
        vec!["gateway", "status", "app"],
        vec!["versions"],
        vec!["commands"],
        vec!["auth", "keys"],
        vec!["config", "edit"],
        vec!["skills", "inspect", "x"],
    ] {
        let output = launch.command().args(&args).output()?;
        assert!(!output.status.success(), "retired command ran: {args:?}");
        let output = launch.command().arg("help").args(&args[..1]).output()?;
        if !["auth", "config", "skills"].contains(&args[0]) {
            assert!(!output.status.success(), "retired help exists: {args:?}");
        }
    }
    assert!(
        !setup
            .sandbox
            .data
            .join("runtime/conversation-store.sqlite")
            .exists()
    );
    skills_import_and_list(&setup.sandbox, &launch)?;
    Ok(())
}

fn skills_import_and_list(
    sandbox: &butler_e2e::e2e::sandbox::Sandbox,
    launch: &butler_e2e::e2e::agent::Launch,
) -> Result<(), HarnessError> {
    use std::io::Write;
    let archive = sandbox.root.join("cli-skill.zip");
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file(
        "cli-skill/SKILL.md",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(
        b"---\nname: cli-skill\ndescription: CLI import fixture\n---\nUse this fixture.\n",
    )?;
    std::fs::write(&archive, zip.finish().unwrap().into_inner())?;
    let output = launch
        .command()
        .args(["skills", "import"])
        .arg(&archive)
        .arg("--json")
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let imported: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(imported["ok"], true, "{imported}");
    let output = launch
        .command()
        .args(["skills", "list", "--json"])
        .output()?;
    assert!(output.status.success());
    let listed: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    assert!(listed.to_string().contains("cli-skill"), "{listed}");
    Ok(())
}
