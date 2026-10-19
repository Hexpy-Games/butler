//! Exercise the shared guided caller on every enforced sandbox host, including
//! data aliases and the App gateway credentials kept in the data folder.
use super::*;
use butler_platform::data_paths::{
    FOLDER_SECRET, GATEWAY_CREDENTIAL_DIRS, LOCAL_ADMIN, LOCAL_AUTH,
};
use butler_turn::workspace::{Commands, GuidedAccess, GuidedCommandInput};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
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

/// Writes each gateway credential under `data` with its change lock
/// (`<name>.lock`) and a rotation temporary named like
/// `secure_fs::unique_temporary` names them, plus an ordinary file one level
/// above each credential folder. Returns both sets, `data`-relative.
fn gateway_fixtures(data: &Path) -> Result<(Vec<PathBuf>, Vec<PathBuf>), HarnessError> {
    let mut private = Vec::new();
    for credential in [LOCAL_AUTH, LOCAL_ADMIN, FOLDER_SECRET] {
        let credential = PathBuf::from(credential);
        let name = credential.file_name().unwrap().to_string_lossy();
        let lock = credential.with_file_name(format!("{name}.lock"));
        let rotation = credential.with_file_name(format!(".{name}.1.0.0.tmp"));
        for path in [credential, lock, rotation] {
            std::fs::create_dir_all(data.join(&path).parent().unwrap())?;
            std::fs::write(data.join(&path), "private-gateway-fixture")?;
            private.push(path);
        }
    }
    let mut neighbours = Vec::new();
    for folder in GATEWAY_CREDENTIAL_DIRS {
        let neighbour = Path::new(folder)
            .parent()
            .unwrap()
            .join("ordinary-neighbour.txt");
        std::fs::write(data.join(&neighbour), "complete-data-fixture")?;
        neighbours.push(neighbour);
    }
    Ok((private, neighbours))
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
        let (gateway, neighbours) = gateway_fixtures(data)?;
        let alias = setup.sandbox.workspace.join("data-alias");
        butler_platform::secure_fs::symlink(data, &alias)?;
        let mut readable = vec![file, alias.join("ordinary.txt")];
        for neighbour in neighbours {
            readable.push(alias.join(&neighbour));
            readable.push(data.join(neighbour));
        }
        for path in &readable {
            let (status, stdout) =
                command(&owner, &setup, data, format!("cat '{}'", path.display())).await?;
            assert_eq!(status, Some(0), "{}", path.display());
            assert_eq!(stdout, b"complete-data-fixture", "{}", path.display());
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
        let mut denied = vec![credential.clone(), auth, alias.join("auth/provider.json")];
        for relative in gateway {
            denied.push(alias.join(&relative));
            denied.push(data.join(relative));
        }
        for private in &denied {
            let (status, stdout) =
                command(&owner, &setup, data, format!("cat '{}'", private.display())).await?;
            assert_ne!(status, Some(0), "{}", private.display());
            assert!(stdout.is_empty(), "credential output must remain empty");
        }
        std::fs::remove_file(alias)?;
    }
    owner.close().await;
    setup.sandbox.mark_success();
    Ok(())
}
