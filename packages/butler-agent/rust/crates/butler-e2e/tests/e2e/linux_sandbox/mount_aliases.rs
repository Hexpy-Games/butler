//! A private bind mount supplies an unknown second view of scratch and secrets.
use super::*;

const FIXTURE: &str = "BUTLER_E2E_MOUNT_ALIAS_ROOT";

#[tokio::test]
async fn sweep_quarantines_mount_alias_targets() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux mount aliases");
    if let Some(root) = std::env::var_os(FIXTURE) {
        return verify_aliases(&PathBuf::from(root));
    }
    let probe = Command::new("unshare")
        .args(["--user", "--map-root-user", "--mount", "true"])
        .output()?;
    butler_e2e::skip_unless!(
        probe.status.success(),
        "private mount namespace unavailable; identity contract covers aliases"
    );
    let mut s = Setup::new("LINUX-MOUNT-ALIASES")?;
    for path in [
        s.sandbox.root.join("view"),
        s.sandbox.data.join("scratch"),
        s.sandbox.data.join("auth"),
        s.sandbox.data.join("profiles"),
    ] {
        std::fs::create_dir_all(path)?;
    }
    let output = Command::new("unshare")
        .args(["--user", "--map-root-user", "--mount", "sh", "-c",
            "set -e; mount --bind \"$1/data\" \"$1/view\"; exec \"$2\" linux_sandbox::mount_aliases::sweep_quarantines_mount_alias_targets --exact --nocapture --test-threads=2", "sh"])
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

fn verify_aliases(base: &Path) -> Result<(), HarnessError> {
    let project = base.join("workspace");
    let data = base.join("data");
    let view = base.join("view");
    let scratch = data.join("scratch");
    std::fs::create_dir_all(project.join("src"))?;
    std::fs::write(data.join("ordinary"), "complete-private")?;
    std::fs::write(data.join("auth/entry"), "complete-credential")?;
    butler_platform::secure_fs::symlink(&data.join("ordinary"), &project.join(".env"))?;
    butler_platform::secure_fs::symlink(&view.join("scratch"), &project.join("src/old"))?;
    std::thread::sleep(Duration::from_millis(1100));
    let before = command_sandbox::discover_project_secret_inventory(&project)?
        .with_writable_roots(&[&scratch]);
    let paths = [
        "auth/missing/deep",
        "profiles",
        "ordinary",
        "scratch",
        "scratch/missing/deep",
    ];
    let mut expected = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let link = project.join(format!("src/new{index}"));
        butler_platform::secure_fs::symlink(&view.join(path), &link)?;
        expected.push(link);
    }
    // The new link traverses scratch before reaching a credential target.
    // Its lexical ancestors must expose that writable indirection.
    butler_platform::secure_fs::symlink(&data.join("auth"), &scratch.join("k"))?;
    butler_platform::secure_fs::symlink(
        &view.join("scratch/k/entry"),
        &project.join("src/escaped"),
    )?;
    expected.push(project.join("src/escaped"));
    expected.sort();
    let environment = HashMap::from([
        ("HOME".into(), base.join("home").display().to_string()),
        (
            "BUTLER_OPENAI_AUTH_PROFILE".into(),
            "profiles/absent".into(),
        ),
    ]);
    let moved = command_sandbox::sweep_new_secrets_with_environment(
        &project,
        &before,
        &data,
        &environment,
    )?;
    assert_eq!(moved, expected);
    // A deliberate old user alias into private scratch is the accepted residual.
    assert_eq!(
        std::fs::read_link(project.join("src/old"))?,
        view.join("scratch")
    );
    for path in moved {
        assert!(std::fs::symlink_metadata(path).is_err());
    }
    assert_eq!(
        std::fs::read_to_string(data.join("ordinary"))?,
        "complete-private"
    );
    assert_eq!(
        std::fs::read_to_string(data.join("auth/entry"))?,
        "complete-credential"
    );
    Ok(())
}
