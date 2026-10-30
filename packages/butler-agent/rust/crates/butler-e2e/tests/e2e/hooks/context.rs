//! Hook output through the real dispatcher, durable admission and provider request.
use super::*;

const SECTION: &str = "## Hook context";
const NOT_THE_USER: &str = "not written by the user";

pub(super) fn printing(setup: &Setup, id: &str, event: &str, text: &str) -> Value {
    json!({"id":id,"event":event,"type":"command","args":fixture(setup,"print"),
        "env":{"HOOK_TEXT":text},"timeout_ms":10000})
}

/// One parent model request per entry, oldest first.
pub(super) fn prompts(s: &Scenario) -> Result<Vec<String>, HarnessError> {
    Ok(s.provider()?
        .requests()
        .iter()
        .filter_map(|request| request["input"][0]["content"][0]["text"].as_str())
        .filter(|text| text.contains("## Current turn context"))
        .map(str::to_owned)
        .collect())
}

/// The request's history and its current-turn part.
pub(super) fn split(prompt: &str) -> (&str, &str) {
    prompt.split_once("## Current turn context").unwrap()
}

/// The labelled section alone: other volatile sections may move between rounds.
pub(super) fn section(prompt: &str) -> &str {
    let (_, current) = split(prompt);
    let start = current.find(SECTION).unwrap();
    let end = current.find("## Current request").unwrap();
    &current[start..end]
}

async fn runs(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    let reply = api(s, Method::GET, "/hooks/runs", None).await?;
    Ok(reply.data().as_array().unwrap().clone())
}

#[tokio::test]
async fn hooks_context_plain_stdout_is_labelled_in_turn_and_history() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("HOOK-CONTEXT-PLAIN")?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let branch = "현재 브랜치: main";
    let mut hook = printing(&setup, "branch", "UserPromptSubmit", branch);
    hook["name"] = json!("Current \"branch\"");
    configure(&setup, &[hook])?;
    let s = setup.start().await?;
    let ask = "First ask.";
    assert_eq!(s.turn("general", ask).await?.1["state"], "delivered");

    let first = prompts(&s)?.pop().unwrap();
    let (history, current) = split(&first);
    assert!(!history.contains(branch), "{history}");
    assert!(current.contains(NOT_THE_USER), "{current}");
    let section = current.find(SECTION).unwrap();
    let from = current
        .find("from: hook \"Current \\\"branch\\\"\" on UserPromptSubmit")
        .unwrap();
    let text = current.find(branch).unwrap();
    let request = current.find("## Current request").unwrap();
    assert!(section < from && from < text && text < request, "{current}");
    assert!(current.ends_with(&format!("## Current request\n{ask}")));

    let db = sqlite::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
    let (role, visibility, origin, turn): (String, String, String, Option<String>) = db.query_row(
        "SELECT role,visibility,origin_kind,turn_id FROM conversation_messages \
         WHERE source_ref LIKE '%:hook-context'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    assert_eq!(
        (role.as_str(), visibility.as_str(), origin.as_str()),
        ("developer", "model", "internal_control")
    );
    assert!(turn.is_some());

    let all = runs(&s).await?;
    let run = all.iter().find(|r| r["hook_id"] == "branch").unwrap();
    assert_eq!(run["outcome"], "continue");
    assert_eq!(run["context_bytes"], branch.len());
    assert!(run["reason"].is_null(), "{run}");
    assert!(run["stdout"].as_str().unwrap().contains(branch));

    replace(&s, vec![]).await?;
    assert_eq!(
        s.turn("general", "Second ask.").await?.1["state"],
        "delivered"
    );
    let second = prompts(&s)?.pop().unwrap();
    let (history, current) = split(&second);
    assert!(
        history.contains(&format!("developer: {SECTION}")),
        "{history}"
    );
    assert!(history.contains(branch), "{history}");
    assert!(history.contains(&format!("user: {ask}")), "{history}");
    assert!(!current.contains(branch), "{current}");

    // Model-only: the App's transcript shows what the user wrote.
    let messages = s.gw.messages("general").await?;
    assert!(!serde_json::to_string(&messages)?.contains(branch));
    s.finish().await
}

#[tokio::test]
async fn hooks_context_json_form_order_and_events_that_add_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = setup("HOOK-CONTEXT-JSON")?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    setup = setup.synthetic(Script {
        rounds: 1,
        path_for: Box::new(|_| "hook-input.txt".into()),
        final_text: "Done.".into(),
    });
    fs::write(setup.sandbox.data.join("hook-input.txt"), "Tool content")?;
    let added = |text: &str| {
        json!({"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":text}})
            .to_string()
    };
    configure(
        &setup,
        &[
            printing(
                &setup,
                "a-json",
                "UserPromptSubmit",
                &added("JSON-FORM-TEXT"),
            ),
            printing(&setup, "b-plain", "UserPromptSubmit", "PLAIN-FORM-TEXT\n"),
            printing(
                &setup,
                "c-decision",
                "UserPromptSubmit",
                r#"{"decision":"continue"}"#,
            ),
            printing(&setup, "d-blank", "UserPromptSubmit", " \n "),
            printing(&setup, "e-empty", "UserPromptSubmit", &added("  ")),
            printing(&setup, "pre", "PreToolUse", "PRE-TOOL-TEXT"),
            printing(&setup, "post", "PostToolUse", &added("POST-TOOL-TEXT")),
            printing(&setup, "stop", "Stop", "STOP-TEXT"),
        ],
    )?;
    let s = setup.start().await?;
    assert_eq!(
        s.turn("general", "Read hook-input.txt, then finish.")
            .await?
            .1["state"],
        "delivered"
    );
    let all = prompts(&s)?;
    assert!(all.len() >= 2, "{}", all.len());
    for prompt in &all {
        let json = prompt.find("from: hook \"a-json\"").unwrap();
        let plain = prompt.find("from: hook \"b-plain\"").unwrap();
        assert!(json < plain, "file order is section order");
        assert_eq!(prompt.matches("JSON-FORM-TEXT").count(), 1);
        assert_eq!(prompt.matches("PLAIN-FORM-TEXT").count(), 1);
        assert_eq!(prompt.matches("from: hook").count(), 2, "{prompt}");
        for other in ["PRE-TOOL-TEXT", "POST-TOOL-TEXT", "STOP-TEXT"] {
            assert!(!prompt.contains(other), "{other}");
        }
    }
    let wire = serde_json::to_string(&s.provider()?.requests())?;
    for other in ["PRE-TOOL-TEXT", "POST-TOOL-TEXT", "STOP-TEXT"] {
        assert!(!wire.contains(other), "{other} reached the model");
    }
    let all = runs(&s).await?;
    let quiet = |id: &str| {
        all.iter()
            .filter(|r| r["hook_id"] == id)
            .all(|r| r["outcome"] == "continue" && r["context_bytes"].is_null())
    };
    assert!(
        ["c-decision", "d-blank", "e-empty", "pre", "post", "stop"]
            .into_iter()
            .all(quiet)
    );
    s.finish().await
}

#[tokio::test]
async fn hooks_context_session_start_goes_with_the_first_turn_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("HOOK-CONTEXT-START")?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let json = json!({"hookSpecificOutput":{"hookEventName":"SessionStart",
        "additionalContext":"START-JSON-TEXT"}})
    .to_string();
    let mut background = printing(&setup, "start-async", "SessionStart", "START-ASYNC-TEXT");
    background["async"] = json!(true);
    configure(
        &setup,
        &[
            printing(&setup, "start-plain", "SessionStart", "START-PLAIN-TEXT"),
            printing(&setup, "start-json", "SessionStart", &json),
            background,
            printing(&setup, "prompt", "UserPromptSubmit", "PROMPT-TEXT"),
        ],
    )?;
    let s = setup.start().await?;
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Start"}))
            .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    assert_eq!(s.turn(&chat, "First.").await?.1["state"], "delivered");
    let first = prompts(&s)?.pop().unwrap();
    let (_, current) = split(&first);
    let start = current.find("START-PLAIN-TEXT").unwrap();
    assert!(start < current.find("START-JSON-TEXT").unwrap());
    assert!(start < current.find("PROMPT-TEXT").unwrap());
    assert!(current.contains("on SessionStart"), "{current}");
    assert_eq!(current.matches(SECTION).count(), 1);

    assert_eq!(s.turn(&chat, "Second.").await?.1["state"], "delivered");
    let second = prompts(&s)?.pop().unwrap();
    let (history, current) = split(&second);
    assert_eq!(history.matches("START-PLAIN-TEXT").count(), 1, "{history}");
    assert!(!current.contains("START-PLAIN-TEXT"), "{current}");
    assert!(current.contains("PROMPT-TEXT"), "{current}");

    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let waiting: u64 = db.query_row(
        "SELECT COUNT(*) FROM session_start_hook_context",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(waiting, 0);
    // A background handler ends after its event: it logs but never adds.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !runs(&s)
        .await?
        .iter()
        .any(|r| r["hook_id"] == "start-async")
    {
        assert!(Instant::now() < deadline, "async hook never finished");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let all = runs(&s).await?;
    let background = all.iter().find(|r| r["hook_id"] == "start-async").unwrap();
    assert!(background["context_bytes"].is_null(), "{background}");
    assert!(!serde_json::to_string(&s.provider()?.requests())?.contains("START-ASYNC-TEXT"));
    s.finish().await
}

#[tokio::test]
async fn hooks_context_failing_hook_inserts_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("HOOK-CONTEXT-FAIL")?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let exits = |id: &str, event: &str, text: &str, code: &str| {
        let mut hook = printing(&setup, id, event, text);
        hook["env"]["HOOK_EXIT"] = json!(code);
        hook
    };
    let crash = exits("crash", "UserPromptSubmit", "CRASH-TEXT", "1");
    let invalid = printing(&setup, "invalid", "UserPromptSubmit", "{INVALID-TEXT");
    let start = exits("start", "SessionStart", "START-TEXT", "2");
    let denied = exits("denied", "UserPromptSubmit", "DENIED-TEXT", "2");
    let mut closed = exits("closed", "UserPromptSubmit", "CLOSED-TEXT", "1");
    closed["failClosed"] = json!(true);
    let mut slow = printing(&setup, "slow", "UserPromptSubmit", "SLOW-TEXT");
    slow["args"] = json!(fixture(&setup, "hold"));
    slow["env"] = json!({"HOOK_HELD":setup.sandbox.home.join("slow-held"),
        "HOOK_RELEASE":setup.sandbox.home.join("never")});
    slow["timeout_ms"] = json!(200);
    configure(&setup, &[crash, invalid, start, slow])?;
    let s = setup.start().await?;
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Fail"}))
            .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    assert_eq!(s.turn(&chat, "Goes on.").await?.1["state"], "delivered");
    let wire = serde_json::to_string(&s.provider()?.requests())?;
    for text in [
        SECTION,
        "CRASH-TEXT",
        "INVALID-TEXT",
        "START-TEXT",
        "SLOW-TEXT",
    ] {
        assert!(!wire.contains(text), "{text} reached the model");
    }
    let all = runs(&s).await?;
    for (id, outcome) in [
        ("crash", "error"),
        ("invalid", "error"),
        ("slow", "timeout"),
    ] {
        let run = all.iter().find(|r| r["hook_id"] == id).unwrap();
        assert_eq!(run["outcome"], outcome, "{run}");
        assert!(run["context_bytes"].is_null(), "{run}");
    }

    let db = sqlite::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
    let stored: u64 = db.query_row(
        "SELECT COUNT(*) FROM conversation_messages WHERE source_ref LIKE '%:hook-context'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(stored, 0);

    // A deny rejects the send, so nothing it printed exists anywhere.
    for hook in [denied, closed] {
        replace(&s, vec![hook]).await?;
        let blocked =
            s.gw.post("/messages", json!({"chat_id":chat,"text":"Rejected."}))
                .await?;
        assert_eq!(blocked.status, 422, "{blocked:?}");
        assert_eq!(blocked.error_code(), Some("hook_blocked"));
    }
    let wire = serde_json::to_string(&s.provider()?.requests())?;
    assert!(!wire.contains("DENIED-TEXT") && !wire.contains("CLOSED-TEXT"));
    s.finish().await
}
