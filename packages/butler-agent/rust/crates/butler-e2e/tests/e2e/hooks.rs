//! Phase-one hooks through the real gateway, process runner and stub model.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "hooks/cancellation.rs"]
mod cancellation;
use super::delegate_followup::stub as child_stub;
#[path = "hooks/limits.rs"]
mod limits;
#[path = "hooks/stub.rs"]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::{Reply, tool_rows},
    provider::Script,
    scenario::{Access, Scenario, Setup},
    security::AdminClient,
};
use butler_platform::{
    command_sandbox,
    process_control::{self, Liveness},
    sqlite,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};
fn setup(name: &str) -> Result<Setup, HarnessError> {
    Ok(Setup::new(name)?.synthetic(Script {
        rounds: 0,
        path_for: Box::new(|_| String::new()),
        final_text: "Done.".into(),
    }))
}
fn hook(id: &str, event: &str, command: &str) -> Value {
    json!({"id":id,"event":event,"type":"command","command":command,"timeout_ms":3000})
}
fn configure(setup: &Setup, hooks: &[Value]) -> Result<(), HarnessError> {
    fs::write(
        setup.sandbox.data.join("hooks.json"),
        json!({"version":1,"hooks":hooks}).to_string(),
    )?;
    Ok(())
}
fn fixture(s: &Setup, name: &str) -> Vec<String> {
    let extension = if command_sandbox::POSIX_SHELL {
        "sh"
    } else {
        "cmd"
    };
    let path =
        butler_e2e::e2e::binary::crate_root().join(format!("tests/e2e/hooks/{name}.{extension}"));
    let to = s.sandbox.home.join(format!("{name}.{extension}"));
    fs::copy(path, &to).unwrap();
    if command_sandbox::POSIX_SHELL {
        vec!["sh".into(), to.to_string_lossy().into_owned()]
    } else {
        vec![
            "cmd.exe".into(),
            "/d".into(),
            "/s".into(),
            "/c".into(),
            to.to_string_lossy().into_owned(),
        ]
    }
}
fn observer(s: &Setup, event: &str) -> Value {
    json!({"id":event,"event":event,"type":"command","args":fixture(s,"observe"),
        "env":{"HOOK_OUTPUT":s.sandbox.home.join("payloads.jsonl"),"HOOK_STOP_ONCE":s.sandbox.home.join("stop-once")},"timeout_ms":3000})
}
fn payloads(home: &Path) -> Vec<Value> {
    fs::read_to_string(home.join("payloads.jsonl"))
        .unwrap()
        .trim_start_matches('\u{feff}')
        .lines()
        .filter(|s| !s.is_empty())
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}
fn security(s: &Scenario) -> AdminClient {
    AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap())
}
async fn api(
    s: &Scenario,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Reply, HarnessError> {
    security(s).send(method, path, body, &[]).await
}
async fn replace(s: &Scenario, hooks: Vec<Value>) -> Result<(), HarnessError> {
    let current = api(s, Method::GET, "/hooks", None).await?;
    assert_eq!(current.status, 200, "{current:?}");
    let saved = api(
        s,
        Method::PUT,
        "/hooks",
        Some(json!({"revision":current.data()["revision"],"config":{"version":1,"hooks":hooks}})),
    )
    .await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    Ok(())
}
#[tokio::test]
async fn hooks_each_parent_event_payload_and_stop_continuation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = setup("HOOK-EVENTS")?;
    setup = setup.synthetic(Script {
        rounds: 1,
        path_for: Box::new(|_| "hook-input.txt".into()),
        final_text: "Done.".into(),
    });
    fs::write(
        setup.sandbox.data.join("hook-input.txt"),
        "Exact tool content",
    )?;
    configure(
        &setup,
        &[
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "Stop",
        ]
        .into_iter()
        .map(|e| observer(&setup, e))
        .collect::<Vec<_>>(),
    )?;
    let s = setup.start().await?;
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Hooks"}))
            .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"].as_str().unwrap();
    let prompt = "Read hook-input.txt, then finish.";
    let (turn_id, turn) = s.turn(chat, prompt).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let payloads = payloads(&s.sandbox.home);
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
    ] {
        assert_eq!(
            payloads
                .iter()
                .filter(|p| p["hook_event_name"] == event)
                .count(),
            1,
            "{payloads:?}"
        );
    }
    for p in &payloads {
        assert_eq!(p["schema"], "butler.hook.v1");
        assert_eq!(p["hook"]["scope"], "user");
        assert_eq!(p["access_mode"], "full_access");
        assert!(p["event_id"].as_str().unwrap().starts_with("evt_"));
        assert!(p["occurred_at"].as_str().unwrap().contains('T'));
        assert!(p["parent_session_id"].is_null());
        assert!(p["session_id"].as_str().is_some());
    }
    let submitted = payloads
        .iter()
        .find(|p| p["hook_event_name"] == "UserPromptSubmit")
        .unwrap();
    assert_eq!(submitted["prompt"], prompt);
    assert_eq!(submitted["attachments"], json!([]));
    let pre = payloads
        .iter()
        .find(|p| p["hook_event_name"] == "PreToolUse")
        .unwrap();
    let post = payloads
        .iter()
        .find(|p| p["hook_event_name"] == "PostToolUse")
        .unwrap();
    assert_eq!(pre["turn_id"], turn_id);
    assert_eq!(pre["tool_name"], "read_file");
    assert_eq!(
        pre["tool_input"],
        json!({"requests":[{"path":"hook-input.txt"}]})
    );
    assert_eq!(pre["resumed"], false);
    assert_eq!(post["tool_use_id"], pre["tool_use_id"]);
    assert_eq!(post["tool_input"], pre["tool_input"]);
    assert_eq!(post["ok"], true);
    assert!(
        post["tool_response"]
            .to_string()
            .contains("Exact tool content")
    );
    let stops: Vec<_> = payloads
        .iter()
        .filter(|p| p["hook_event_name"] == "Stop")
        .collect();
    assert_eq!(stops.len(), 2);
    assert_eq!(stops[0]["stop_hook_active"], false);
    assert_eq!(stops[1]["stop_hook_active"], true);
    assert_eq!(stops[1]["last_assistant_message"], "Done.");
    s.finish().await
}
#[tokio::test]
async fn hooks_pretool_deny_is_model_feedback_without_tool_or_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("HOOK-TOOL-DENY")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .access(Access::AskFirst);
    let command = if command_sandbox::POSIX_SHELL {
        "echo 'Guard reason' >&2; exit 2"
    } else {
        "echo Guard reason 1>&2 & exit /b 2"
    };
    let mut guard = hook("guard", "PreToolUse", command);
    guard["match"] = json!({"tools":["run_command"]});
    configure(&setup, &[guard])?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(stub::command);
    let (turn_id, turn) = s.turn("general", "Run the hook test command.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert!(!s.sandbox.home.join("tool-ran").exists());
    assert!(s.gw.approval_requests("general").await?.is_empty());
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    assert_eq!(rows.len(), 2, "{rows:?}");
    let denied = rows
        .iter()
        .find(|r| r["tool_call_id"] == "call_hooks")
        .unwrap();
    assert_eq!(denied["safe_tool_name"], "run_command");
    assert_eq!(denied["state"], "failed", "{rows:?}");
    let requests = s.provider()?.requests();
    assert!(
        requests.iter().skip(1).any(
            |r| r.to_string().contains("hook_denied") && r.to_string().contains("Guard reason")
        ),
        "{requests:?}"
    );
    s.finish().await
}
#[tokio::test]
async fn hooks_crash_failclosed_prompt_deny_and_next_send() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("HOOK-FAILURE")?.start().await?;
    let crash = if command_sandbox::POSIX_SHELL {
        "kill -SEGV $$"
    } else {
        "exit /b 3"
    };
    replace(&s, vec![hook("crash", "UserPromptSubmit", crash)]).await?;
    assert_eq!(
        s.turn("general", "First send.").await?.1["state"],
        "delivered"
    );
    let mut guard = hook("crash", "UserPromptSubmit", crash);
    guard["failClosed"] = json!(true);
    replace(&s, vec![guard]).await?;
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let count = || {
        db.query_row("SELECT COUNT(*) FROM session_queued_messages", [], |r| {
            r.get::<_, u64>(0)
        })
        .unwrap()
    };
    let before = count();
    let blocked =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general","text":"Keep draft.","client_message_id":"hook-blocked"}),
        )
        .await?;
    assert_eq!(blocked.status, 422, "{blocked:?}");
    assert_eq!(blocked.error_code(), Some("hook_blocked"));
    assert_eq!(count(), before);
    let deny = if command_sandbox::POSIX_SHELL {
        "echo '{\"decision\":\"deny\",\"reason\":\"No send\"}'"
    } else {
        "echo {\"decision\":\"deny\",\"reason\":\"No send\"}"
    };
    replace(&s, vec![hook("deny", "UserPromptSubmit", deny)]).await?;
    let blocked =
        s.gw.post("/messages", json!({"chat_id":"general","text":"No send."}))
            .await?;
    assert_eq!(blocked.status, 422, "{blocked:?}");
    assert_eq!(count(), before);
    replace(&s, vec![]).await?;
    assert_eq!(
        s.turn("general", "Next send works.").await?.1["state"],
        "delivered"
    );
    drop(db);
    s.finish().await
}
#[tokio::test]
async fn hooks_timeout_kills_tree_and_follows_failclosed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("HOOK-TIMEOUT")?;
    let pids = setup.sandbox.home.join("hook-pids");
    let mut hook = json!({"id":"tree","event":"UserPromptSubmit","type":"command","args":fixture(&setup,"tree"),
        "timeout_ms":300,"env":{"HOOK_PIDS":pids}});
    configure(&setup, &[hook.clone()])?;
    let s = setup.start().await?;
    assert_eq!(
        s.turn("general", "Timeout proceeds.").await?.1["state"],
        "delivered"
    );
    let pids: Vec<u32> = fs::read_to_string(&pids)?
        .lines()
        .map(|p| p.trim().parse().unwrap())
        .collect();
    assert!(!pids.is_empty());
    for pid in pids {
        assert_eq!(
            process_control::liveness(pid),
            Liveness::Gone,
            "hook descendant {pid}"
        );
    }
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    assert_eq!(runs.data()[0]["outcome"], "timeout");
    hook["failClosed"] = json!(true);
    replace(&s, vec![hook]).await?;
    let blocked =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general","text":"Timeout blocks."}),
        )
        .await?;
    assert_eq!(blocked.status, 422, "{blocked:?}");
    s.finish().await
}
#[tokio::test]
async fn hooks_no_config_idle_has_zero_writes_for_three_windows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("HOOK-IDLE")?.start().await?;
    // Startup completes before observing unchanged idle database versions.
    s.turn("general", "Settle startup.").await?;
    let app = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let btcc = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let version = |db: &rusqlite::Connection| {
        db.query_row("PRAGMA data_version", [], |r| r.get::<_, u64>(0))
            .unwrap()
    };
    let before = (version(&app), version(&btcc));
    for window in 0..3 {
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(!s.sandbox.data.join("hooks.json").exists());
        assert_eq!(
            (version(&app), version(&btcc)),
            before,
            "idle window {window}"
        );
        assert_eq!(
            api(&s, Method::GET, "/hooks/runs", None).await?.data(),
            &json!([])
        );
        eprintln!("HOOK-IDLE window={window}: hook writes=0, DB commits=0, runs=0");
    }
    drop((app, btcc));
    s.finish().await
}
#[tokio::test]
async fn hooks_subagentstop_has_parent_and_exact_answer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, _script, server) = child_stub::start(false).await?;
    let setup = Setup::new("HOOK-CHILD")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url);
    configure(&setup, &[observer(&setup, "SubagentStop")])?;
    let s = setup.start().await?;
    s.turn("general", child_stub::OWNER).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
        if !runs.data().as_array().unwrap().is_empty() {
            break;
        }
        assert!(Instant::now() < deadline, "child never stopped");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let payloads = payloads(&s.sandbox.home);
    assert_eq!(payloads.len(), 1, "{payloads:?}");
    let child = &payloads[0];
    assert_eq!(child["hook_event_name"], "SubagentStop");
    assert_eq!(child["parent_session_id"], "butler/app-general");
    assert_ne!(child["session_id"], child["parent_session_id"]);
    assert_eq!(
        child["last_assistant_message"],
        "Original evidence: paper A verified."
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
