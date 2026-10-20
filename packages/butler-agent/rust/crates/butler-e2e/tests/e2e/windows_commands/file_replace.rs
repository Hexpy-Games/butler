//! Native rename-replace refusals: a read-only target is final, and the
//! retry decision for every refusal code and source/target or source/parent probe.
use super::capability_stub::{self as provider, Case};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Setup},
};
use butler_platform::secure_fs::replace_retry::{DeleteProbe, replacement_retry_allowed};
use serde_json::json;
use std::fs;

#[tokio::test]
async fn edit_file_readonly_target_is_a_permanent_permission_denial() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Native read-only attribute required"
    );
    run_case().await
}

// test-category: pure-logic
#[test]
fn replace_retry_follows_rename_code_and_delete_probes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    const OK: DeleteProbe = Ok(());
    let probed = |probes: Option<[DeleteProbe; 2]>| move || probes;
    let unprobed = || -> Option<[DeleteProbe; 2]> { panic!("only ACCESS_DENIED probes") };
    for (rename, probes, retry) in [
        (Some(5), Some([OK, OK]), true),
        (Some(5), Some([Err(Some(32)), OK]), true),
        (Some(5), Some([OK, Err(Some(33))]), true),
        (Some(5), Some([Err(Some(5)), OK]), false),
        (Some(5), Some([OK, Err(Some(5))]), false),
        (Some(5), Some([OK, Err(Some(2))]), false),
        (Some(5), Some([Err(None), OK]), false),
        (Some(5), None, false),
        // First creation probes source DELETE and parent FILE_ADD_FILE.
        (Some(5), Some([OK, Err(Some(32))]), true),
        (Some(5), Some([Err(Some(33)), OK]), true),
        (Some(5), Some([Err(Some(2)), OK]), false),
        (Some(5), Some([OK, Err(Some(3))]), false),
        (Some(5), Some([OK, Err(None)]), false),
    ] {
        assert_eq!(
            replacement_retry_allowed(rename, probed(probes)),
            retry,
            "{rename:?} {probes:?}"
        );
    }
    for (rename, retry) in [
        (Some(32), true),
        (Some(33), true),
        (Some(2), false),
        (Some(1224), false),
        (None, false),
    ] {
        assert_eq!(
            replacement_retry_allowed(rename, unprobed),
            retry,
            "{rename:?}"
        );
    }
    for (code, pending, retry) in [(Some(5), false, false), (Some(5), true, true)] {
        assert_eq!(
            butler_platform::secure_fs::read_retry_allowed(code, || pending),
            retry
        );
    }
    for (code, retry) in [
        (Some(32), true),
        (Some(33), true),
        (Some(2), false),
        (Some(3), false),
        (Some(303), false),
        (None, false),
    ] {
        assert_eq!(
            butler_platform::secure_fs::read_retry_allowed(code, || {
                panic!("only ACCESS_DENIED probes")
            }),
            retry
        );
    }
    Ok(())
}

async fn run_case() -> Result<(), HarnessError> {
    let setup = Setup::new("FILE-MUTATION-READONLY")?;
    let directory = setup.sandbox.home.join("Desktop");
    fs::create_dir(&directory)?;
    let path = directory.join("document.txt");
    fs::write(&path, "before\n")?;
    let mut permissions = fs::metadata(&path)?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions)?;
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
    let (_, turn) = s.turn("general", provider::PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered");
    let (output, _) = script.result.lock().unwrap().clone().unwrap();
    assert_eq!(output["ok"], false, "{output}");
    assert_eq!(
        output["error"]["code"], "effect_dispatch_failed",
        "{output}"
    );
    assert!(
        output["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("permission_denied: "),
        "{output}"
    );
    assert_eq!(fs::read_to_string(&path)?, "before\n");
    let logs = s.agent.logs();
    assert!(
        !logs.contains("probe=delete"),
        "read-only target must not retry"
    );
    assert_eq!(logs.matches("phase=replace_attempt").count(), 1, "{logs}");
    assert_eq!(fs::read_dir(&directory)?.count(), 1, "staging was cleaned");
    butler_platform::secure_fs::remove_tree(&directory)?;
    s.finish().await?;
    server.abort();
    Ok(())
}
