//! Scratch aliases remain sandbox-controlled after the command has exited.
use super::*;

#[tokio::test]
async fn guided_sweep_quarantines_all_scratch_indirections() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux scratch links");
    use butler_turn::workspace::{Commands, GuidedAccess, GuidedCommandInput};
    let mut s = Setup::new("LINUX-SCRATCH-LINKS")?;
    let root = &s.sandbox.workspace;
    std::fs::create_dir_all(root.join("src"))?;
    std::fs::create_dir_all(s.sandbox.home.join(".ssh"))?;
    std::fs::write(s.sandbox.home.join(".ssh/id_rsa"), "private-fixture")?;
    let public = s.sandbox.home.join("public");
    std::fs::create_dir_all(&public)?;
    std::fs::write(public.join("entry"), "complete-public")?;
    let scratch = [
        s.sandbox.data.join("tmp/project-write"),
        s.sandbox
            .data
            .join(butler_platform::data_paths::PROJECT_WRITE_CACHE),
        s.sandbox.data.join(butler_platform::data_paths::ARTIFACTS),
    ];
    for (index, path) in scratch.iter().enumerate() {
        std::fs::create_dir_all(path)?;
        std::fs::write(path.join("file"), "complete-cache")?;
        std::fs::write(path.join("plain"), "complete-cache")?;
        butler_platform::secure_fs::symlink(path, &root.join(format!("src/old{index}")))?;
        butler_platform::secure_fs::symlink(
            &path.join("file"),
            &root.join(format!("src/oldfile{index}")),
        )?;
    }
    // These aliases are older than the ctime cutoff; scratch still cannot be trusted.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let command = format!(
        "set -e; i=0; for d in \"$TMPDIR\" \"$XDG_CACHE_HOME\" \"$BUTLER_ARTIFACTS_DIR\"; do ln -s '{}/.ssh' \"$d/k\"; rm \"$d/file\"; ln -s \"$d/k/id_rsa\" \"$d/file\"; ln -s \"$d\" src/dir$i; ln -s \"$d/plain\" src/file$i; i=$((i+1)); done; ln -s '{}' src/public",
        s.sandbox.home.display(),
        public.display()
    );
    let owner = Commands::new();
    let output = owner
        .submit_guided(GuidedCommandInput {
            command,
            cwd: None,
            workspace_root: root.clone(),
            butler_data: s.sandbox.data.clone(),
            timeout_ms: Some(10_000.0),
            access: GuidedAccess::ProjectWrite,
            host_environment: HashMap::from([
                ("HOME".into(), s.sandbox.home.display().to_string()),
                ("PATH".into(), std::env::var("PATH").unwrap()),
            ]),
            abort: tokio_util::sync::CancellationToken::new(),
        })
        .unwrap()
        .await
        .unwrap();
    owner.close().await;
    let output = output.unwrap();
    std::fs::remove_file(output.payload_source.path)?;
    assert_eq!(output.summary.exit_code, Some(0));
    let mut expected = Vec::new();
    for index in 0..3 {
        for prefix in ["dir", "file", "old", "oldfile"] {
            let path = root.join(format!("src/{prefix}{index}"));
            assert!(std::fs::symlink_metadata(&path).is_err());
            expected.push(path);
        }
    }
    expected.sort();
    assert_eq!(output.summary.sandbox_violation, expected);
    assert_eq!(
        std::fs::read_to_string(root.join("src/public/entry"))?,
        "complete-public"
    );
    assert_eq!(
        std::fs::read_to_string(s.sandbox.home.join(".ssh/id_rsa"))?,
        "private-fixture"
    );
    s.sandbox.mark_success();
    Ok(())
}
