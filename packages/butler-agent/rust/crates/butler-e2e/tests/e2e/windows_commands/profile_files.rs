//! Opt-in complete file-tool listing proof. Diagnostics expose counts only.
use super::capability_stub::{self as provider, Case};
use butler_e2e::e2e::{
    HarnessError,
    gateway::{tool_rows, turn_state},
    scenario::{Access, Scenario, Setup, accepted_turn_id},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

type Snapshot = BTreeMap<PathBuf, (bool, u64, std::time::SystemTime)>;

fn snapshot(root: &Path) -> Result<Snapshot, HarnessError> {
    std::fs::read_dir(root)?
        .map(|entry| {
            let entry = entry?;
            let metadata = entry.metadata()?;
            Ok((
                entry.path(),
                (metadata.is_file(), metadata.len(), metadata.modified()?),
            ))
        })
        .collect()
}

fn verify_order(before: &Snapshot, listed: &[String]) {
    let mut expected: Vec<String> = before
        .iter()
        .filter(|(_, metadata)| metadata.0)
        .map(|(path, _)| path.to_string_lossy().replace('\\', "/"))
        .collect();
    expected.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    assert!(
        listed == expected,
        "Complete listing preserves UTF-16 order"
    );
}

async fn complete_output(s: &Scenario, turn_id: &str) -> Result<Value, HarnessError> {
    let messages = s.gw.messages("general").await?;
    let rows = tool_rows(&messages, turn_id);
    let row = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "list_files")
        .expect("listing operation is visible");
    // Large results have a bounded model preview; verify the full public output.
    let text = s.gw.operation_output(turn_id, row).await?;
    let result: Value = serde_json::from_str(&text)?;
    Ok(result)
}

async fn replay(downloads: &Path, access: Access) -> Result<(), HarnessError> {
    let before = snapshot(downloads)?;
    let excluded: Vec<String> = before
        .iter()
        .filter(|(_, v)| !v.0)
        .map(|(path, _)| format!("{}/**", path.to_string_lossy().replace('\\', "/")))
        .collect();
    let mut case = Case {
        tool: "list_files",
        refused: false,
        args: json!({
        "root":downloads,"max_results":1000,"max_depth":1,"exclude_globs":excluded}),
    };
    let (url, script, server) = provider::start(case.clone()).await?;
    let setup = Setup::new("OWNER-DOWNLOADS-FILE-REPLAY")?;
    let local = setup.sandbox.home.join("AppData/Local");
    let roaming = setup.sandbox.home.join("AppData/Roaming");
    std::fs::create_dir_all(&local)?;
    std::fs::create_dir_all(&roaming)?;
    let s = setup
        .stub_cassette(super::observation_stub::cassette()?)
        .access(access)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("LOCALAPPDATA", local.display().to_string())
        .env("APPDATA", roaming.display().to_string())
        .env("BUTLER_SECRET_STORE", "file")
        .env("BUTLER_PLATFORM_SYSTEM_SECRETS", "0")
        .env("BUTLER_APP_DISABLE_SHELL_REGISTRATION", "1")
        .start()
        .await?;
    let mut seen = BTreeMap::new();
    let mut ordered = Vec::new();
    let mut maximum_ms = 0.0_f64;
    loop {
        script.select(case.clone());
        let accepted = s.gw.say("general", "다운로드 폴더 정리해줘").await?;
        let id = accepted_turn_id(&accepted)?;
        if access == Access::AskFirst {
            super::file_paths::approve(&s, &id, &case, &script).await?;
        }
        let turn =
            s.gw.wait_terminal("general", &id, Duration::from_secs(15))
                .await?;
        assert_eq!(turn_state(&turn), "delivered");
        let (_, elapsed) = script
            .result
            .lock()
            .unwrap()
            .clone()
            .expect("model receives file tool result");
        let read_started = Instant::now();
        let result = complete_output(&s, &id).await?;
        let elapsed = elapsed + read_started.elapsed();
        assert!(
            result["ok"] == true,
            "list_files failed; error={}",
            result["error"]
        );
        assert_eq!(result["io_errors"], 0);
        butler_e2e::assert_wall_clock_budget!(
            elapsed,
            Duration::from_secs(5),
            "Owner Downloads list_files"
        );
        maximum_ms = maximum_ms.max(elapsed.as_secs_f64() * 1000.);
        for item in result["files"].as_array().unwrap() {
            let path = PathBuf::from(item["path"].as_str().unwrap());
            ordered.push(path.to_string_lossy().replace('\\', "/"));
            let expected = before
                .get(&path)
                .expect("listed file belongs to the unchanged folder");
            assert!(
                expected.0 && item["bytes"].as_u64() == Some(expected.1),
                "metadata must match disk"
            );
            assert!(seen.insert(path, expected.1).is_none(), "no duplicates");
        }
        if result["truncated"] == false {
            break;
        }
        let cursor = result["next_cursor"]
            .as_str()
            .expect("complete bounded continuation");
        case.args["cursor"] = json!(cursor);
    }
    assert_eq!(
        seen.len(),
        before.values().filter(|v| v.0).count(),
        "all top-level regular files listed"
    );
    verify_order(&before, &ordered);
    assert!(
        snapshot(downloads)? == before,
        "owner files and metadata unchanged"
    );
    if access == Access::FullAccess {
        assert!(s.gw.approval_requests("general").await?.is_empty());
    }
    eprintln!(
        "OWNER-DOWNLOADS list_files {access:?}: files={}, directories={}, max={maximum_ms:.1}ms; unchanged",
        seen.len(),
        before.values().filter(|v| !v.0).count()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn owner_downloads_file_tool_replay_in_both_access_modes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some(path) = std::env::var_os("BUTLER_E2E_DOWNLOADS_REAL_PATH") else {
        return Ok(());
    };
    for access in [Access::AskFirst, Access::FullAccess] {
        replay(Path::new(&path), access).await?;
    }
    Ok(())
}
