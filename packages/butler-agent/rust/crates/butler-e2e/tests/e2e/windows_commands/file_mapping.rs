//! Native mapped-view retries, synchronized with actual DELETE probes.
use super::capability_stub::{self as provider, Case};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Scenario, Setup},
};
use butler_platform::secure_fs::fixture_locks::{MappedView, mapped_view};
use serde_json::json;
use std::{fs, io::Write, path::Path, time::Duration};

#[tokio::test]
async fn edit_file_survives_a_transient_mapped_view() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Native mapped view required"
    );
    run_case(false, false).await
}

#[tokio::test]
async fn edit_file_preserves_an_external_save_during_mapped_view_retry() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Native mapped view required"
    );
    run_case(true, false).await
}

#[tokio::test]
async fn edit_file_readonly_target_is_a_permanent_permission_denial() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Native read-only attribute required"
    );
    run_case(false, true).await
}

async fn release_after_delete_probes(
    s: &Scenario,
    holder: Option<MappedView>,
    external_save: Option<&Path>,
) -> Result<(), HarnessError> {
    if holder.is_none() {
        return Ok(());
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let logs = s.agent.logs();
            let probes = |role| {
                logs.matches(&format!(
                    "phase=rename os_code=Some(5) probe=delete role={role} probe_os_code=None"
                ))
                .count()
            };
            // Five observed failures span four existing 50 ms backoffs.
            // No guessed sleep determines whether the product hit the conflict.
            if probes("source") >= 5 && probes("target") >= 5 {
                if let Some(path) = external_save {
                    fs::OpenOptions::new()
                        .write(true)
                        .open(path)?
                        .write_all(b"saved!\n")?;
                }
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .map_err(|_| HarnessError("No mapped-view DELETE-success conflicts observed".into()))??;
    drop(holder);
    Ok(())
}

async fn run_case(external_save: bool, readonly: bool) -> Result<(), HarnessError> {
    let setup = Setup::new("FILE-MUTATION-MAPPED-VIEW")?;
    let directory = setup.sandbox.home.join("Desktop");
    fs::create_dir(&directory)?;
    let path = directory.join("document.txt");
    fs::write(&path, "before\n")?;
    let holder = if readonly {
        let mut permissions = fs::metadata(&path)?.permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions)?;
        None
    } else {
        let control = setup.sandbox.home.join("holder");
        fs::create_dir(&control)?;
        let mapped_path = path.clone();
        Some(
            tokio::task::spawn_blocking(move || mapped_view(&mapped_path, &control))
                .await
                .map_err(|error| HarnessError(error.to_string()))??,
        )
    };
    let (url, script, server) = provider::start(Case {
        tool: "edit_file",
        args: json!({"path":path,"old_text":"before","new_text":"after"}),
        refused: false,
    })
    .await?;
    let s = setup
        .stub_cassette(super::observation_stub::cassette()?)
        .access(Access::FullAccess)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_DEBUG_COMMAND_TIMINGS", "1")
        .start()
        .await?;
    let (turn, release) = tokio::join!(
        s.turn("general", provider::PROMPT),
        release_after_delete_probes(&s, holder, external_save.then_some(path.as_path())),
    );
    release?;
    assert_eq!(turn_state(&turn?.1), "delivered");
    let (output, _) = script.result.lock().unwrap().clone().unwrap();
    if external_save || readonly {
        assert_eq!(output["ok"], false, "{output}");
        assert_eq!(
            output["error"]["code"], "effect_dispatch_failed",
            "{output}"
        );
        let expected = if readonly {
            "permission_denied: "
        } else {
            "external_change_conflict: "
        };
        assert!(
            output["error"]["message"]
                .as_str()
                .unwrap()
                .starts_with(expected),
            "{output}"
        );
        assert_eq!(
            fs::read_to_string(&path)?,
            if readonly { "before\n" } else { "saved!\n" }
        );
    } else {
        assert_eq!(output["ok"], true, "{output}");
        assert_eq!(fs::read_to_string(&path)?, "after\n");
    }
    if readonly {
        let logs = s.agent.logs();
        assert!(
            !logs.contains("probe=delete"),
            "read-only target must not retry"
        );
        assert_eq!(logs.matches("phase=replace_attempt").count(), 1, "{logs}");
    }
    assert_eq!(fs::read_dir(&directory)?.count(), 1, "staging was cleaned");
    if readonly {
        butler_platform::secure_fs::remove_tree(&directory)?;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
