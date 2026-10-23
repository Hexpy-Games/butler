//! Private bind mounts supply unknown directory and single-file aliases.
use super::*;
const FIXTURE: &str = "BUTLER_E2E_MOUNT_ALIAS_ROOT";

#[tokio::test]
async fn reader_refuses_mount_alias_targets() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux mount aliases");
    if let Some(root) = std::env::var_os(FIXTURE) {
        return verify_aliases(&PathBuf::from(root)).await;
    }
    let probe = Command::new("unshare")
        .args(["--user", "--map-root-user", "--mount", "true"])
        .output()?;
    butler_e2e::skip_unless!(
        probe.status.success(),
        "private mount namespace unavailable"
    );
    let mut s = Setup::new("LINUX-MOUNT-ALIASES")?;
    for path in [
        s.sandbox.workspace.join("view"),
        s.sandbox.data.join("auth"),
    ] {
        std::fs::create_dir_all(path)?;
    }
    std::fs::write(s.sandbox.data.join("auth/entry"), "private-fixture")?;
    std::fs::write(s.sandbox.workspace.join("leaf"), "complete-public")?;
    let output = Command::new("unshare")
        .args(["--user", "--map-root-user", "--mount", "sh", "-c",
            "set -e; mount --bind \"$1/data\" \"$1/workspace/view\"; mount --bind \"$1/data/auth/entry\" \"$1/workspace/leaf\"; exec \"$2\" linux_sandbox::mount_aliases::reader_refuses_mount_alias_targets --exact --nocapture --test-threads=2", "sh"])
        .arg(&s.sandbox.root).arg(std::env::current_exe()?)
        .env(FIXTURE, &s.sandbox.root).output()?;
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    s.sandbox.mark_success();
    Ok(())
}
async fn verify_aliases(base: &Path) -> Result<(), HarnessError> {
    let root = base.join("workspace");
    let data = base.join("data");
    for path in ["view/auth/entry", "leaf"] {
        let result = super::secret_changes::read(&root, &data, path).await;
        assert_eq!(result["ok"], false);
        assert!(result.get("content").is_none());
    }
    Ok(())
}
