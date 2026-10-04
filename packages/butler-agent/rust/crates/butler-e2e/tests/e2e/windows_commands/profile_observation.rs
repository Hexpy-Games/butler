//! Released failure replay: real profile with external data, and default layout.
use super::observation_stub as provider;
use butler_e2e::e2e::{
    HarnessError,
    gateway::{tool_rows, turn_state},
    scenario::{Access, Setup, accepted_turn_id, turn_timeout},
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, Instant},
};

// 2026-10-04 06:20:05 KST, call 467a95dcf5c4b0b58ce5f850b5c8892f9ca840a05b04e0a56a51368dbb5ae031.
// Replay the released call verbatim, including its parenthesized property access.
const FAILED_COMMAND: &str = r#"powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'; $raw=(Get-ItemProperty -LiteralPath $key).'{374DE290-123F-4565-9164-39C4925E467B}'; if([string]::IsNullOrWhiteSpace($raw)){throw 'Downloads known-folder setting missing'}; $path=[Environment]::ExpandEnvironmentVariables($raw); $items=@(Get-ChildItem -LiteralPath $path -Force | Select-Object Name,Extension,PSIsContainer,Length,Attributes,LastWriteTimeUtc); [pscustomobject]@{Source=$key;RawPath=$raw;DownloadsPath=$path;Items=$items}|ConvertTo-Json -Depth 4 -Compress""#;

type Snapshot = BTreeMap<String, (bool, u64, std::time::SystemTime)>;

fn snapshot(downloads: &Path) -> Result<Snapshot, HarnessError> {
    std::fs::read_dir(downloads)?
        .map(|entry| {
            let entry = entry?;
            let enumerated = entry.metadata()?;
            let metadata = butler_platform::secure_fs::current_metadata(&entry.path())?;
            if enumerated.len() != metadata.len()
                || enumerated.modified()? != metadata.modified()?
            {
                // Do not expose real-profile names in diagnostic output.
                eprintln!(
                    "PROFILE snapshot cache differs: directory={} enumerated_length={} current_length={} enumerated_modified={:?} current_modified={:?}",
                    metadata.is_dir(), enumerated.len(), metadata.len(),
                    enumerated.modified()?, metadata.modified()?
                );
            }
            Ok((
                entry.file_name().to_string_lossy().into_owned(),
                (metadata.is_dir(), metadata.len(), metadata.modified()?),
            ))
        })
        .collect()
}

fn fixtures(setup: &Setup) -> Result<(), HarnessError> {
    let downloads = setup.sandbox.home.join("Downloads");
    std::fs::create_dir_all(downloads.join("nested"))?;
    std::fs::write(downloads.join("보고서.txt"), "document")?;
    std::fs::write(downloads.join("사진.png"), "image")?;
    std::fs::write(downloads.join("nested/must-not-list.txt"), "private")?;
    // Force the public artifact path in both hosted profile layouts as well
    // as the real profile; a tiny fixture only tests the model preview.
    for index in 0..96 {
        std::fs::write(
            downloads.join(format!("entry-{index:03}.txt")),
            "complete listing",
        )?;
    }
    Ok(())
}

async fn replay(
    access: Access,
    default_layout: bool,
    real_profile: Option<&str>,
) -> Result<(), HarnessError> {
    let started = Instant::now();
    let mut setup = Setup::new("PROFILE-OBSERVATION")?;
    if default_layout {
        setup.sandbox.data = setup.sandbox.home.join(".butler");
        std::fs::create_dir_all(&setup.sandbox.data)?;
    }
    fixtures(&setup)?;
    let home = real_profile.map_or_else(|| setup.sandbox.home.display().to_string(), str::to_owned);
    let downloads = Path::new(&home).join("Downloads");
    let before = snapshot(&downloads)?;
    // Never write the registry to simulate a known folder. Fixture tests still
    // read the real registration and use their own profile for the listing.
    let command = if real_profile.is_some() {
        FAILED_COMMAND.to_owned()
    } else {
        FAILED_COMMAND.replace(
            "$path=[Environment]::ExpandEnvironmentVariables($raw);",
            "$path=Join-Path $env:USERPROFILE 'Downloads';",
        )
    };
    let (url, script, server) = provider::start(&command, false).await?;
    let local = setup.sandbox.root.join("local");
    let roaming = setup.sandbox.root.join("roaming");
    std::fs::create_dir_all(&local)?;
    std::fs::create_dir_all(&roaming)?;
    let setup = setup
        .stub_cassette(provider::cassette()?)
        .access(access)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("LOCALAPPDATA", local.display().to_string())
        .env("APPDATA", roaming.display().to_string())
        // Match the installed App, which does not inherit a console module path.
        .env("PSModulePath", "")
        .env("BUTLER_DEBUG_COMMAND_TIMINGS", "1")
        .env("BUTLER_SECRET_STORE", "file")
        .env("BUTLER_PLATFORM_SYSTEM_SECRETS", "0")
        .env("BUTLER_APP_DISABLE_SHELL_REGISTRATION", "1");
    let s = setup.start().await?;
    let accepted = s.gw.say("general", super::stub::PROMPT).await?;
    let id = accepted_turn_id(&accepted)?;
    if access == Access::AskFirst {
        super::observation::approve_exact(&s, &id, &command).await?;
    }
    let turn =
        s.gw.wait_terminal("general", &id, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "chat must finish");
    let requests = script.requests.lock().unwrap().clone();
    let received = requests
        .iter()
        .rev()
        .find(|request| {
            provider::outputs(request)
                .iter()
                .any(|output| output["command"] == command)
        })
        .expect("model receives this command's tool result");
    let output = provider::outputs(received)
        .into_iter()
        .find(|output| output["command"] == command)
        .expect("exact command result in the selected model request");
    let read_started = Instant::now();
    let messages = s.gw.messages("general").await?;
    let rows = tool_rows(&messages, &id);
    let row = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "run_command")
        .expect("command operation is visible");
    let full: Value = serde_json::from_str(&s.gw.operation_output(&id, row).await?)?;
    assert!(
        full["command"] == command,
        "exact command result is retained"
    );
    let stdout = complete_stdout(&full, &s.sandbox.data)?;
    verify(&output, &stdout, &downloads, &before)?;
    let read_elapsed = read_started.elapsed();
    // A later closeout/briefing request need not replay command output. Check
    // the request that actually carries it; verify() retains all content checks.
    assert!(received.to_string().contains("DownloadsPath"));
    let command_elapsed = script.elapsed.lock().unwrap().unwrap();
    eprintln!(
        "PROFILE-TIMING model_tool_roundtrip_ms={:.3} full_output_read_ms={:.3}",
        command_elapsed.as_secs_f64() * 1000.,
        read_elapsed.as_secs_f64() * 1000.
    );
    for line in s.agent.logs().lines().filter(|line| {
        line.contains("command_phase_timing") || line.contains("command_process_timing")
    }) {
        eprintln!("{line}");
    }
    let elapsed = command_elapsed + read_elapsed;
    butler_e2e::assert_wall_clock_budget!(elapsed, Duration::from_secs(5), "Downloads observation");
    eprintln!(
        "PROFILE-OBSERVATION command: {:.1}ms",
        elapsed.as_secs_f64() * 1000.
    );
    if access == Access::FullAccess {
        assert!(s.gw.approval_requests("general").await?.is_empty());
    }
    assert!(
        s.gw.messages("general")
            .await?
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == super::stub::ANSWER)
    );
    eprintln!(
        "PROFILE-OBSERVATION {access:?} default={default_layout} real={}: verified in {:?}",
        real_profile.is_some(),
        started.elapsed()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn verify(
    output: &Value,
    stdout: &str,
    downloads: &Path,
    before: &Snapshot,
) -> Result<(), HarnessError> {
    // Assertion diagnostics must not dump the owner's file names.
    assert!(
        output["exit_code"] == 0,
        "command must succeed: error={}, stderr={}",
        output["error"],
        output["stderr"]
    );
    assert_eq!(output["sandbox"], "unisolated");
    let listing: Value = serde_json::from_str(stdout)?;
    assert_eq!(listing["DownloadsPath"].as_str(), downloads.to_str());
    assert!(listing["Source"].as_str().unwrap().starts_with("HKCU:"));
    assert!(!listing["RawPath"].as_str().unwrap().is_empty());
    let items = listing["Items"].as_array().expect("all top-level entries");
    assert_eq!(items.len(), before.len(), "complete listing");
    let mut seen = BTreeMap::new();
    let mut extensions = BTreeMap::<String, usize>::new();
    for item in items {
        let name = item["Name"].as_str().unwrap();
        let folder = item["PSIsContainer"].as_bool().unwrap();
        assert!(
            before.get(name).is_some_and(|value| value.0 == folder),
            "listing names and folder flags must match disk"
        );
        assert!(item.get("Extension").is_some() && item.get("Attributes").is_some());
        assert!(item.get("LastWriteTimeUtc").is_some());
        if !folder {
            assert!(
                item["Length"].as_u64() == before.get(name).map(|value| value.1),
                "complete file length matches the latest snapshot"
            );
        }
        assert!(seen.insert(name, folder).is_none(), "no duplicate entries");
        *extensions
            .entry(item["Extension"].as_str().unwrap_or_default().to_owned())
            .or_default() += 1;
    }
    let after = snapshot(downloads)?;
    for (index, (name, previous)) in before.iter().enumerate() {
        if after.get(name) != Some(previous) {
            eprintln!(
                "PROFILE snapshot changed slot={index}: before={previous:?} after={:?}",
                after.get(name)
            );
        }
    }
    assert!(
        after == *before,
        "no entry created/moved/deleted/renamed or modified"
    );
    eprintln!(
        "DOWNLOADS evidence: entries={}, folders={}, extensions={extensions:?}",
        items.len(),
        seen.values().filter(|folder| **folder).count()
    );
    Ok(())
}

#[tokio::test]
async fn profile_downloads_with_external_data_in_both_access_modes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows profile replay"
    );
    // Opt-in only: keep CODEX_HOME, all data and caches in the sandbox even
    // when HOME/USERPROFILE describe the real read-only Downloads proof.
    let real = std::env::var("BUTLER_E2E_DOWNLOADS_REAL_PROFILE").ok();
    for access in [Access::AskFirst, Access::FullAccess] {
        replay(access, false, real.as_deref()).await?;
    }
    Ok(())
}

#[tokio::test]
async fn profile_downloads_with_default_dot_butler_layout_in_both_access_modes()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows profile replay"
    );
    for access in [Access::AskFirst, Access::FullAccess] {
        replay(access, true, None).await?;
    }
    Ok(())
}

#[tokio::test]
async fn literal_current_directory_stays_protected_after_member_access() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows path syntax"
    );
    let command = r"$p=([pscustomobject]@{Name='profile'}).'Name'; Get-ChildItem -LiteralPath '.'";
    let setup = Setup::new("PROFILE-DOT-DENIED")?;
    let (url, script, server) = provider::start(command, false).await?;
    let s = setup
        .stub_cassette(provider::cassette()?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_SECRET_STORE", "file")
        .env("BUTLER_PLATFORM_SYSTEM_SECRETS", "0")
        .env("BUTLER_APP_DISABLE_SHELL_REGISTRATION", "1")
        .start()
        .await?;
    let (_, turn) = s.turn("general", super::stub::PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered");
    let requests = script.requests.lock().unwrap().clone();
    let output = requests
        .iter()
        .rev()
        .flat_map(provider::outputs)
        .find(|v| v["command"] == command)
        .expect("protected result");
    assert_eq!(output["error"], "protected_path");
    assert_eq!(output["protected_path"], ".");
    assert_eq!(output["stdout"], "");
    let elapsed = script.elapsed.lock().unwrap().unwrap();
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_secs(1),
        "Protected path refusal"
    );
    assert!(s.gw.approval_requests("general").await?.is_empty());
    s.finish().await?;
    server.abort();
    Ok(())
}

/// Every output byte is retrieved, including the original command artifact
/// when its model-facing presentation uses a bounded preview.
fn complete_stdout(output: &Value, data: &Path) -> Result<String, HarnessError> {
    if let Some(artifact) = output.get("butler_tool_artifact") {
        let path = Path::new(artifact["path"].as_str().expect("artifact path"));
        let root = data.join("artifacts/tool-output").canonicalize()?;
        assert!(
            path.canonicalize()?.starts_with(root),
            "artifact stays in isolated data"
        );
        let raw: Value = serde_json::from_slice(&std::fs::read(path)?)?;
        assert!(raw["id"] == artifact["id"], "exact artifact identity");
        assert!(
            raw["command"] == output["command"],
            "exact command identity"
        );
        assert!(raw["result"]["exit_code"] == 0, "full result succeeded");
        assert!(
            raw["result"]["timed_out"] == false,
            "full result did not time out"
        );
        return Ok(raw["result"]["stdout"]
            .as_str()
            .expect("complete stdout")
            .to_owned());
    }
    assert!(
        output["output_presentation"]["truncated"] == false,
        "complete output or artifact required"
    );
    Ok(output["stdout"]
        .as_str()
        .expect("complete stdout")
        .to_owned())
}
