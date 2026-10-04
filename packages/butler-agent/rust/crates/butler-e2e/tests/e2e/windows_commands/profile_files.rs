//! Opt-in, read-only owner Downloads proof. Diagnostics expose counts only.
use super::capability_stub::{self as provider, Case};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Setup, accepted_turn_id},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
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
    let mut maximum_ms = 0.0_f64;
    loop {
        script.select(case.clone());
        let accepted = s.gw.say("general", "다운로드 폴더 정리해줘").await?;
        let id = accepted_turn_id(&accepted)?;
        if access == Access::AskFirst {
            super::file_paths::approve(&s, &id, &case).await?;
        }
        let turn =
            s.gw.wait_terminal("general", &id, Duration::from_secs(15))
                .await?;
        assert_eq!(turn_state(&turn), "delivered");
        let (result, elapsed) = script
            .result
            .lock()
            .unwrap()
            .clone()
            .expect("model receives file tool output");
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
