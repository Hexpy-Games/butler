use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::Value;
use std::path::Path;

pub(super) async fn immutable(s: &Scenario, id: &str) -> Result<(), HarnessError> {
    let root = std::fs::read_dir(s.sandbox.data.join("project-ledger/projects"))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    let root = root
        .into_iter()
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("wm-session-")
        })
        .collect::<Vec<_>>();
    assert_eq!(root.len(), 1);
    let cli =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../project-ledger/bin/project-ledger");
    for operation in ["create", "update"] {
        let output = tokio::process::Command::new(
            std::env::var("BUTLER_BUN").unwrap_or_else(|_| "bun".into()),
        )
        .arg(&cli)
        .args(["record", operation, "--project"])
        .arg(&root[0])
        .args([
            "--id",
            id,
            "--kind",
            "spec",
            "--title",
            "Overwrite",
            "--json",
        ])
        .env("HOME", &s.sandbox.home)
        .env("BUTLER_DATA", &s.sandbox.data)
        .kill_on_drop(true)
        .output()
        .await?;
        assert!(!output.status.success());
        let response: Value = serde_json::from_slice(&output.stdout)?;
        assert_eq!(response["error"]["code"], "immutable_spec_revision");
    }
    Ok(())
}
