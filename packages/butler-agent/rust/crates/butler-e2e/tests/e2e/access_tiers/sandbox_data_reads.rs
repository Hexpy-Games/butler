//! Exercise the shared guided caller on Linux and macOS, including data aliases.
use super::*;
use butler_turn::workspace::{Commands, GuidedAccess, GuidedCommandInput};
use std::{collections::HashMap, path::Path};
use tokio_util::sync::CancellationToken;

async fn command(
    owner: &Commands,
    setup: &Setup,
    data: &Path,
    command: String,
) -> Result<(Option<i32>, Vec<u8>), HarnessError> {
    let output = owner
        .submit_guided(GuidedCommandInput {
            command,
            cwd: None,
            workspace_root: setup.sandbox.workspace.clone(),
            butler_data: data.to_path_buf(),
            timeout_ms: Some(10_000.0),
            access: GuidedAccess::ContainedObservation,
            host_environment: HashMap::from([
                ("HOME".into(), setup.sandbox.home.display().to_string()),
                ("PATH".into(), std::env::var("PATH").unwrap()),
            ]),
            abort: CancellationToken::new(),
        })
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    let payload = std::fs::read(&output.payload_source.path)?;
    let start = usize::try_from(output.payload_source.stdout_start).unwrap();
    let len = usize::try_from(output.payload_source.stdout_len).unwrap();
    let stdout = payload[start..start + len].to_vec();
    std::fs::remove_file(output.payload_source.path)?;
    Ok((output.summary.exit_code, stdout))
}

#[tokio::test]
async fn contained_commands_allow_data_reads_and_keep_writes_and_credentials_denied()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::approval_free_reads(),
        "Requires an enforced command sandbox"
    );
    let mut setup = Setup::new("SANDBOX-DATA-READS")?;
    let default_data = setup.sandbox.home.join(".butler");
    std::fs::create_dir_all(&default_data)?;
    let credential = setup.sandbox.home.join(".ssh/id_test");
    std::fs::create_dir_all(credential.parent().unwrap())?;
    std::fs::write(&credential, "fixture-credential")?;
    let owner = Commands::new();
    for data in [&setup.sandbox.data, &default_data] {
        let file = data.join("ordinary.txt");
        std::fs::write(&file, "complete-data-fixture")?;
        let auth = data.join("auth/provider.json");
        std::fs::create_dir_all(auth.parent().unwrap())?;
        std::fs::write(&auth, "private-auth-fixture")?;
        let alias = setup.sandbox.workspace.join("data-alias");
        butler_platform::secure_fs::symlink(data, &alias)?;
        for path in [&file, &alias.join("ordinary.txt")] {
            let (status, stdout) =
                command(&owner, &setup, data, format!("cat '{}'", path.display())).await?;
            assert_eq!(status, Some(0));
            assert_eq!(stdout, b"complete-data-fixture");
        }
        let target = data.join("denied-write.txt");
        let (status, _) = command(
            &owner,
            &setup,
            data,
            format!("echo mutation > '{}'", target.display()),
        )
        .await?;
        assert_ne!(status, Some(0));
        assert!(!target.exists());
        for private in [&credential, &auth, &alias.join("auth/provider.json")] {
            let (status, stdout) =
                command(&owner, &setup, data, format!("cat '{}'", private.display())).await?;
            assert_ne!(status, Some(0));
            assert!(stdout.is_empty(), "credential output must remain empty");
        }
        std::fs::remove_file(alias)?;
    }
    owner.close().await;
    setup.sandbox.mark_success();
    Ok(())
}
