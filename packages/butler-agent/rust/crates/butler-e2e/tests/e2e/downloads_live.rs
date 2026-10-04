//! Owner-authorized live acceptance; opt-in, real profile observation, no filenames in reports.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    gateway::{tool_rows, turn_state},
    live,
    scenario::{Access, Setup, accepted_turn_id},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

type Snapshot = BTreeMap<PathBuf, (bool, u64, std::time::SystemTime)>;
fn snapshot(path: &Path) -> Result<Snapshot, HarnessError> {
    std::fs::read_dir(path)?
        .map(|e| {
            let e = e?;
            let m = e.metadata()?;
            Ok((e.path(), (m.is_dir(), m.len(), m.modified()?)))
        })
        .collect()
}

async fn approvals(s: &butler_e2e::e2e::scenario::Scenario) -> Result<(), HarnessError> {
    for card in s.gw.approval_requests("general").await? {
        let capability = card["approval"]["action_kind"].as_str().unwrap_or("");
        if !card["questions"].is_null() {
            continue;
        }
        let effect = card["approval"]["command_access"].as_str();
        assert!(
            (capability == "other"
                && matches!(
                    card["executable"].as_str(),
                    Some("read_file" | "list_files" | "grep_files")
                ))
                || (capability == "run_command" && effect == Some("read_only_unisolated")),
            "Live observation must await move approval; refusing to approve a mutation"
        );
        let reference = card["request_ref"].as_str().unwrap();
        let reply =
            s.gw.post(
                &format!("/authority-requests/{reference}/allow?session_id=general"),
                json!({"scope":"once"}),
            )
            .await?;
        assert_eq!(reply.status, 202);
    }
    Ok(())
}

async fn run(
    access: Access,
    repeat: usize,
    profile: &str,
    downloads: &Path,
) -> Result<bool, HarnessError> {
    let provider = live::gate("DOWNLOADS-LIVE")?.expect("live credentials required");
    assert_eq!(provider.choice.model, "openai/gpt-6-luna");
    let before = snapshot(downloads)?;
    let mut extensions = BTreeMap::<String, usize>::new();
    for (path, metadata) in &before {
        let kind = if metadata.0 {
            "directory".into()
        } else {
            path.extension().map_or_else(
                || "no-extension".into(),
                |v| v.to_string_lossy().to_lowercase(),
            )
        };
        *extensions.entry(kind).or_default() += 1;
    }
    let files = before.values().filter(|v| !v.0).count();
    let folders = before.len() - files;
    let setup = Setup::new("DOWNLOADS-LIVE")?;
    let local = setup.sandbox.root.join("local");
    let roaming = setup.sandbox.root.join("roaming");
    std::fs::create_dir_all(&local)?;
    std::fs::create_dir_all(&roaming)?;
    let s = setup
        .live(provider)
        .access(access)
        .env("USERPROFILE", profile)
        .env("LOCALAPPDATA", local.display().to_string())
        .env("APPDATA", roaming.display().to_string())
        .env("BUTLER_SECRET_STORE", "file")
        .env("BUTLER_PLATFORM_SYSTEM_SECRETS", "0")
        .env("BUTLER_APP_DISABLE_SHELL_REGISTRATION", "1")
        .start()
        .await?;
    let language =
        s.gw.patch("/personalization", json!({"response_language":"ko"}))
            .await?;
    assert_eq!(language.status, 200);
    live::spend_turn()?;
    let started = Instant::now();
    let id = accepted_turn_id(&s.gw.say("general", "다운로드 폴더 정리해줘").await?)?;
    let deadline = started + Duration::from_secs(300);
    let mut timed_out = false;
    loop {
        if access == Access::AskFirst {
            approvals(&s).await?;
        }
        let answer = proposal(&s).await?;
        let terminal_proposal = reported_types(&answer, &extensions)
            && answer.contains(&files.to_string())
            && answer.contains(&folders.to_string())
            && (answer.contains("승인")
                || answer.contains("확인")
                || answer.contains("진행할까요"));
        if terminal_proposal
            && timings(&s.sandbox.data)?
                .iter()
                .any(|t| t.starts_with("run_command:") || t.starts_with("list_files:"))
        {
            break;
        }
        let cards = s.gw.approval_requests("general").await?;
        let question = cards.iter().any(|c| !c["questions"].is_null());
        let view = s.gw.get("/session-view?session_id=general").await?;
        let children_pending = view.data()["steward_children"]
            .as_array()
            .is_some_and(|children| children.iter().any(|c| c["terminal"] != true));
        let turns = s.gw.turns("general").await?;
        let settled = !turns.is_empty()
            && turns
                .iter()
                .all(|t| butler_e2e::e2e::gateway::TERMINAL.contains(&turn_state(t)));
        if question || (settled && !children_pending && cards.is_empty()) {
            break;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let messages = s.gw.messages("general").await?;
    let rows = tool_rows(&messages, &id);
    let tools: Vec<_> = rows
        .iter()
        .map(|r| r["safe_tool_name"].as_str().unwrap_or("?"))
        .collect();
    let answer = proposal(&s).await?;
    let actual_totals =
        answer.contains(&files.to_string()) && answer.contains(&folders.to_string());
    let actual_types = reported_types(&answer, &extensions);
    let move_confirmation =
        answer.contains("승인") || answer.contains("확인") || answer.contains("진행할까요");
    let observed = timings(&s.sandbox.data)?
        .iter()
        .any(|t| t.starts_with("run_command:") || t.starts_with("list_files:"));
    let complete = actual_totals && actual_types && move_confirmation && observed && !timed_out;
    eprintln!(
        "DOWNLOADS-LIVE acceptance: totals={actual_totals}; types={actual_types}; confirmation={move_confirmation}; observed={observed}; timed_out={timed_out}"
    );
    eprintln!(
        "DOWNLOADS-LIVE {access:?} #{repeat}: {:.2}s; entries={}; files={files}; folders={folders}; types={extensions:?}; tools={tools:?}",
        started.elapsed().as_secs_f64(),
        before.len()
    );
    assert!(
        snapshot(downloads)? == before,
        "Downloads entries/metadata changed"
    );
    eprintln!(
        "DOWNLOADS-LIVE tool timings: {:?}",
        timings(&s.sandbox.data)?
    );
    s.finish().await?;
    Ok(complete)
}

#[tokio::test]
async fn owner_downloads_six_real_chats() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Ok(profile) = std::env::var("BUTLER_E2E_DOWNLOADS_LIVE_PROFILE") else {
        return Ok(());
    };
    let downloads = PathBuf::from(
        std::env::var("BUTLER_E2E_DOWNLOADS_REAL_PATH")
            .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?,
    );
    let mut completed = 0;
    for access in [Access::AskFirst, Access::FullAccess] {
        for repeat in 1..=3 {
            completed += usize::from(run(access, repeat, &profile, &downloads).await?);
        }
    }
    assert_eq!(
        completed, 6,
        "Report incomplete live acceptance without tuning the product to this scenario"
    );
    Ok(())
}

fn timings(data: &Path) -> Result<Vec<String>, HarnessError> {
    let db = butler_platform::sqlite::open_with_flags(
        data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    let mut query = db.prepare("SELECT tool_name, started_at, finished_at, error_code FROM btcc_guided_tool_calls WHERE finished_at IS NOT NULL ORDER BY started_at, turn_sequence")
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    let rows = query
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    rows.map(|row| {
        let (name, start, finish, error) =
            row.map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
        let ms = start.zip(finish).and_then(|(a, b)| {
            Some(
                (chrono::DateTime::parse_from_rfc3339(&b).ok()?
                    - chrono::DateTime::parse_from_rfc3339(&a).ok()?)
                .num_milliseconds(),
            )
        });
        Ok(format!(
            "{name}:{}ms:{}",
            ms.unwrap_or(0),
            error.as_deref().unwrap_or("ok")
        ))
    })
    .collect()
}

async fn proposal(s: &butler_e2e::e2e::scenario::Scenario) -> Result<String, HarnessError> {
    let messages = s.gw.messages("general").await?;
    let mut text = messages
        .iter()
        .filter(|m| m["role"] == "assistant")
        .filter_map(|m| m["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    for card in s.gw.approval_requests("general").await? {
        if !card["questions"].is_null() {
            text.push_str(&card["questions"].to_string());
        }
    }
    Ok(text)
}

/// Compare complete actual type counts without logging the private answer.
fn reported_types(answer: &str, extensions: &BTreeMap<String, usize>) -> bool {
    extensions
        .iter()
        .filter(|(kind, _)| kind.as_str() != "directory")
        .all(|(kind, count)| {
            answer.lines().any(|line| {
                line.to_lowercase().contains(kind)
                    && line
                        .split(|c: char| !c.is_ascii_digit())
                        .any(|n| n.parse::<usize>().ok() == Some(*count))
            })
        })
}
