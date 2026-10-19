//! Real edit tool publication while another process denies delete sharing.
use super::capability_stub::{self as provider, Case};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Setup},
};
use butler_platform::secure_fs::fixture_locks::deny_delete;
use serde_json::json;
use std::{fs, path::Path, time::Duration};

async fn release_after_publication_starts(
    directory: &Path,
    lock: fs::File,
    external_save: Option<&Path>,
) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if fs::read_dir(directory)?.any(|entry| {
                entry.is_ok_and(|entry| entry.path().extension().is_some_and(|ext| ext == "tmp"))
            }) {
                // Outlast the old 180 ms budget while leaving ample room for
                // the bounded 950 ms replacement retry window.
                tokio::time::sleep(Duration::from_millis(350)).await;
                if let Some(path) = external_save {
                    fs::write(path, "external save\n")?;
                    // Keep denying replacement until the edit re-checks and drops its staging
                    // file, so no rename can follow an unchecked save.
                    while fs::read_dir(directory)?.any(|entry| {
                        entry.is_ok_and(|entry| {
                            entry.path().extension().is_some_and(|ext| ext == "tmp")
                        })
                    }) {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .map_err(|_| HarnessError("File publication did not start".into()))??;
    drop(lock);
    Ok(())
}

#[tokio::test]
async fn edit_file_survives_a_transient_delete_sharing_lock() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Native delete sharing required"
    );
    run_sharing_case(false).await
}

#[tokio::test]
async fn edit_file_preserves_an_external_save_during_sharing_retry() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Native delete sharing required"
    );
    run_sharing_case(true).await
}

async fn run_sharing_case(external_save: bool) -> Result<(), HarnessError> {
    let setup = Setup::new("FILE-MUTATION-SHARING")?;
    let directory = setup.sandbox.home.join("Desktop");
    fs::create_dir(&directory)?;
    let path = directory.join("document.txt");
    fs::write(&path, "before\n")?;
    let lock = deny_delete(&path)?;
    let case = Case {
        tool: "edit_file",
        args: json!({"path":path,"old_text":"before","new_text":"after"}),
        refused: false,
    };
    let (url, script, server) = provider::start(case).await?;
    let s = setup
        .stub_cassette(super::observation_stub::cassette()?)
        .access(Access::FullAccess)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    let (turn, release) = tokio::join!(
        s.turn("general", provider::PROMPT),
        release_after_publication_starts(&directory, lock, external_save.then_some(path.as_path())),
    );
    release?;
    assert_eq!(turn_state(&turn?.1), "delivered");
    let (output, _) = script.result.lock().unwrap().clone().unwrap();
    if external_save {
        assert_eq!(output["ok"], false, "{output}");
        assert_eq!(
            output["error"]["code"], "effect_dispatch_failed",
            "{output}"
        );
        assert!(
            output["error"]["message"]
                .as_str()
                .is_some_and(|message| message.starts_with("external_change_conflict: ")),
            "{output}"
        );
        assert_eq!(fs::read_to_string(&path)?, "external save\n");
    } else {
        assert_eq!(output["ok"], true, "{output}");
        assert_eq!(fs::read_to_string(&path)?, "after\n");
    }
    assert_eq!(fs::read_dir(&directory)?.count(), 1, "staging was cleaned");
    s.finish().await?;
    server.abort();
    Ok(())
}
