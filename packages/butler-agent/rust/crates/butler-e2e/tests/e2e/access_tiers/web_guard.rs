//! R5: tainted data-bearing requests gate before any web provider can see data.
use super::stub::{self, call};
use super::{approve, assert_counts, delivered, outputs, paused};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Setup},
};
use serde_json::json;

#[tokio::test]
async fn external_content_web_requests_ask_with_exact_targets() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("PERM-WEB")?
        .clock_after_daily_jobs("2026-09-27T12:00:00.000Z")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let outside = setup.sandbox.home.join("outside.txt");
    std::fs::write(&outside, "External note")?;
    let s = setup.start().await?;
    let config_path = s.sandbox.data.join("butler.config.json");
    let mut config: serde_json::Value = serde_json::from_slice(&std::fs::read(&config_path)?)?;
    config["webSearch"] =
        json!({"provider":"mock", "readerBackend":"disabled", "planning":{"enabled":false}});
    std::fs::write(config_path, serde_json::to_vec(&config)?)?;
    let query = "x ".repeat(65);
    let target = "https://example.com/?q=external-note";
    for (prompt, tool, args, exact) in [
        (
            "Read the note and search.",
            "web_search",
            json!({"query":query}),
            query.as_str(),
        ),
        (
            "Read the note and open the page.",
            "web_read",
            json!({"url":target}),
            target,
        ),
    ] {
        script.rounds.lock().unwrap().insert(
            prompt.into(),
            vec![
                call(
                    "outside",
                    "read_file",
                    &json!({"requests":[{"path":outside.to_string_lossy()}]}),
                ),
                call("web", tool, &args),
            ],
        );
        let turn = paused(&s, "general", prompt).await?;
        approve(&s, "general", "allow").await?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let cards = s.gw.approval_requests("general").await?;
            if let Some(card) = cards.first() {
                assert_eq!(card["approval"]["action_kind"], "web_request", "{card}");
                assert_eq!(card["approval"]["operation"]["targets"][0], exact, "{card}");
                assert_eq!(card["reason"], "authority.taintReason");
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "web request did not ask"
            );
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_counts(&s, &turn, 2, 1)?;
        approve(&s, "general", "deny").await?;
        delivered(&s, "general", &turn).await?;
        assert_counts(&s, &turn, 2, 0)?;
        let results = outputs(&s, "general", &turn, &script, prompt).await?;
        assert!(
            results
                .iter()
                .any(|value| value.contains("authority_request_denied"))
        );
    }
    let prompt = format!("Read the note, then open {target}");
    script.rounds.lock().unwrap().insert(
        prompt.clone(),
        vec![
            call(
                "outside",
                "read_file",
                &json!({"requests":[{"path":outside.to_string_lossy()}]}),
            ),
            call("known", "web_read", &json!({"url":target})),
        ],
    );
    let turn = paused(&s, "general", &prompt).await?;
    approve(&s, "general", "allow").await?;
    delivered(&s, "general", &turn).await?;
    assert_counts(&s, &turn, 1, 0)?;
    unattended(&s, &script, &query).await?;
    // Attachments taint a read-only turn without requiring an approved read.
    let uploaded =
        s.gw.upload(
            "note.txt",
            "text/plain",
            b"Outside attachment",
            Some("general"),
        )
        .await?;
    assert_eq!(uploaded.status, 201, "{}", uploaded.text);
    let file_id = uploaded.data()["file"]["file_id"].clone();
    script.rounds.lock().unwrap().insert(
        "Read-only web request.".into(),
        vec![call("web", "web_search", &json!({"query":query}))],
    );
    let response =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general", "text":"Read-only web request.",
        "client_message_id":"web-read-only", "access_mode":"read_only",
        "attachments":[{"file_id":file_id}]}),
        )
        .await?;
    let turn = s.gw.accepted_turn(response.data()).await?;
    delivered(&s, "general", &turn).await?;
    assert_counts(&s, &turn, 0, 0)?;
    let results = outputs(&s, "general", &turn, &script, "Read-only web request.").await?;
    assert!(
        results
            .iter()
            .any(|value| value.contains("web_request_blocked_after_external_content")),
        "{results:?}"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn unattended(
    s: &butler_e2e::e2e::scenario::Scenario,
    script: &std::sync::Arc<stub::Script>,
    query: &str,
) -> Result<(), HarnessError> {
    let prompt = "Research then send outside content.";
    script.rounds.lock().unwrap().insert(
        prompt.into(),
        vec![
            call("research", "web_search", &json!({"query":"research"})),
            call("send", "web_search", &json!({"query":query})),
        ],
    );
    let created =
        s.gw.post(
            "/automations",
            json!({"title":"Research", "prompt_body":prompt,
        "target_session_id":"general", "access_mode":"auto", "schedule_type":"once",
        "run_at":"2000-01-01T00:00:00.000Z"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let schedule = created.data()["automation"]["id"].as_str().unwrap();
    assert_eq!(
        s.gw.post("/automations/dispatch-due", json!({}))
            .await?
            .status,
        202
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let runs = s.gw.get(&format!("/automations/{schedule}/runs")).await?;
        if let Some(run) = runs.data()["runs"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|run| run["safe_error_code"] == "schedule_permission_required")
        {
            let turn = run["turn_id"].as_str().unwrap();
            delivered(s, "general", turn).await?;
            assert_counts(s, turn, 0, 0)?;
            let results = outputs(s, "general", turn, script, prompt).await?;
            assert!(
                results
                    .iter()
                    .any(|value| value.contains("schedule_permission_required")
                        && value.contains("read outside content")),
                "{results:?}"
            );
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "scheduled web request did not fail fast"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Ok(())
}

#[tokio::test]
async fn external_content_scores_individual_path_segments() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("PERM-WEB-PATH")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let outside = setup.sandbox.home.join("outside.txt");
    std::fs::write(&outside, "External note")?;
    let s = setup.start().await?;
    let config_path = s.sandbox.data.join("butler.config.json");
    let mut config: serde_json::Value = serde_json::from_slice(&std::fs::read(&config_path)?)?;
    config["webSearch"] =
        json!({"provider":"mock", "readerBackend":"disabled", "planning":{"enabled":false}});
    std::fs::write(config_path, serde_json::to_vec(&config)?)?;
    for (index, (path, carries)) in [
        ("wiki/Rust_programming_language", false),
        ("abcdefghijkl/mnopqrstuvwx", false),
        ("docs/readable-deep.link_slug", false),
        ("aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7b", true),
        ("ZXh0ZXJuYWwtY29udGVudA==", true),
    ]
    .into_iter()
    .enumerate()
    {
        let target = format!("https://example.com/{path}");
        let prompt = format!("Read the outside note, then follow link {index}.");
        script.rounds.lock().unwrap().insert(
            prompt.clone(),
            vec![
                call(
                    "outside",
                    "read_file",
                    &json!({"requests":[{"path":outside.to_string_lossy()}]}),
                ),
                call("web", "web_read", &json!({"url":target})),
            ],
        );
        let turn = paused(&s, "general", &prompt).await?;
        approve(&s, "general", "allow").await?;
        if carries {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            loop {
                let cards = s.gw.approval_requests("general").await?;
                if let Some(card) = cards.first() {
                    assert_eq!(card["approval"]["action_kind"], "web_request", "{card}");
                    assert_eq!(card["approval"]["operation"]["targets"][0], target);
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "opaque segment did not ask"
                );
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            approve(&s, "general", "deny").await?;
        }
        delivered(&s, "general", &turn).await?;
        assert_counts(&s, &turn, if carries { 2 } else { 1 }, 0)?;
        let results = outputs(&s, "general", &turn, &script, &prompt).await?;
        assert_eq!(
            results
                .iter()
                .any(|value| value.contains("authority_request_denied")),
            carries
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn auto_project_read_then_web_search_needs_no_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("PERM-WEB-PROJECT")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let folder = setup.sandbox.home.join("projects");
    std::fs::create_dir_all(&folder)?;
    let mut s = setup.start().await?;
    let chat = crate::project_workspace::bind_project(&mut s, &folder).await?;
    let readme = folder.join("작업 Project/README.md");
    let content = "프로젝트 안내: ".repeat(65);
    std::fs::write(&readme, &content)?;
    let config_path = s.sandbox.data.join("butler.config.json");
    let mut config: serde_json::Value = serde_json::from_slice(&std::fs::read(&config_path)?)?;
    config["webSearch"] =
        json!({"provider":"mock", "readerBackend":"disabled", "planning":{"enabled":false}});
    std::fs::write(config_path, serde_json::to_vec(&config)?)?;
    let prompt = "Read README then search the web for its content.";
    script.rounds.lock().unwrap().insert(
        prompt.into(),
        vec![
            call(
                "readme",
                "read_file",
                &json!({"requests":[{"path":"README.md"}]}),
            ),
            call("search", "web_search", &json!({"query":content})),
        ],
    );
    let turn = s.gw.say_turn(&chat, prompt).await?;
    delivered(&s, &chat, &turn).await?;
    assert_counts(&s, &turn, 0, 0)?;
    let output = outputs(&s, &chat, &turn, &script, prompt).await?;
    assert_eq!(output.len(), 2, "{output:?}");
    assert!(output.iter().any(|r| r.contains(&content)), "{output:?}");
    assert!(
        output.iter().all(
            |r| !r.contains("authority_request") && !r.contains("schedule_permission_required")
        ),
        "{output:?}"
    );
    assert!(
        script.requests_for(prompt).last().unwrap()["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "function_call_output")
            .filter_map(
                |item| serde_json::from_str::<serde_json::Value>(item["output"].as_str()?).ok()
            )
            .all(|r| r["output"]["ok"] == true),
        "{output:?}"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
