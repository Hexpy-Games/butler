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
) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if fs::read_dir(directory)?.any(|entry| {
                entry.is_ok_and(|entry| entry.path().extension().is_some_and(|ext| ext == "tmp"))
            }) {
                // Keep a real incompatible handle alive beyond the old 180 ms
                // retry budget, without changing either file's contents.
                tokio::time::sleep(Duration::from_millis(800)).await;
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
        release_after_publication_starts(&directory, lock),
    );
    release?;
    assert_eq!(turn_state(&turn?.1), "delivered");
    let (output, _) = script.result.lock().unwrap().clone().unwrap();
    assert_eq!(output["ok"], true, "{output}");
    assert_eq!(fs::read_to_string(&path)?, "after\n");
    assert_eq!(fs::read_dir(&directory)?.count(), 1, "staging was cleaned");
    s.finish().await?;
    server.abort();
    Ok(())
}
