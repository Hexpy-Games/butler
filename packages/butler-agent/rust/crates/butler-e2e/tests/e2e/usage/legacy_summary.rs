//! The daily transcript summary of a chat is that chat's usage in Settings › Usage.
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::scenario::{Fixture, Setup};
use butler_e2e::e2e::{HarnessError, fixtures};
use serde_json::{Value, json};

const NOW: &str = "2026-10-02T04:01:00.000Z";
const TITLE: &str = "Garden notes";
const JOBS: [&str; 2] = ["session-sync", "consolidation-cycle"];

#[tokio::test]
async fn use_legacy_summary_counts_toward_its_chat() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior {
        answer: "**Chat**: The user plans a spring garden.".into(),
        chunk_delay: std::time::Duration::ZERO,
        ..ChatBehavior::default()
    })
    .await?;
    let setup = Setup::new("USE-LEGACY-SUMMARY")?
        .fixture(Fixture::Empty)
        .env("BUTLER_E2E_APP_NOW", NOW);
    // Existing data keeps a fresh memory generation from starting, so the
    // daily sync takes the legacy transcript summary path.
    let existing = setup.sandbox.data.join("cognition/box/previous.md");
    std::fs::create_dir_all(existing.parent().unwrap())?;
    std::fs::write(&existing, b"existing source")?;
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, NOW)?;
    let mut s = setup.start().await?;
    let reply =
        s.gw.post(
            "/model-catalog/local-models",
            json!({
                "provider_id":"local","api_type":"openai_compatible","platform":"ollama",
                "server_url":server.base_url,"model_id":LOCAL_MODEL,"display_name":LOCAL_MODEL,
                "context_window_tokens":131_072,"source":"discovered"
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let model = reply.data()["model"]["model_ref"]
        .as_str()
        .unwrap()
        .to_owned();
    let reply = s.gw.patch("/settings", json!({"model":model})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let reply =
        s.gw.post("/sessions", json!({"kind":"chat","title":TITLE}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let chat = reply.data()["session"]["id"].as_str().unwrap().to_owned();
    let (_, turn) = s.turn(&chat, "Plan a spring garden with tulips.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert!(
        !s.sandbox
            .data
            .join("cognition/memory/active-generation.json")
            .exists()
    );

    // The next start after 04:00 runs the daily jobs once more.
    s.agent.terminate().await?;
    for job in JOBS {
        std::fs::remove_file(s.sandbox.data.join(format!("state/scheduler/{job}.json")))?;
    }
    super::super::memory_fixture::arm_consolidation(&s.sandbox.data, "2026-10-02T03:59:00.000Z")?;
    s.gw = s.agent.start_again().await?;
    let cache = s.sandbox.data.join("cognition/memory/hot/cache.md");
    // Durable completion barrier; the timeout only guards against a hang.
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        while !JOBS.iter().all(|job| {
            std::fs::read(s.sandbox.data.join(format!("state/scheduler/{job}.json")))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .is_some_and(|state| state["lastRunDate"] == NOW[..10])
        }) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("daily jobs did not finish");
    assert!(
        std::fs::read_to_string(&cache)?.contains("spring garden"),
        "legacy summary was not written"
    );

    let rows: Vec<Value> =
        std::fs::read_to_string(s.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?
            .lines()
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()?;
    let summary: Vec<_> = rows
        .iter()
        .filter(|r| r["phase"] == "memory_extraction")
        .collect();
    assert_eq!(summary.len(), 1, "{rows:?}");
    let summary = summary[0];
    let turn_row = rows
        .iter()
        .find(|r| r["turnId"].is_string() && r["rootSessionId"].is_string())
        .unwrap_or_else(|| panic!("chat turn usage lacks its root: {rows:?}"));
    assert_eq!(summary["scope"], "memory-hot-summary", "{summary}");
    assert_eq!(
        summary["rootSessionId"], turn_row["rootSessionId"],
        "{summary}"
    );
    assert_eq!(summary["role"], "main", "{summary}");
    let chat_rows = rows
        .iter()
        .filter(|r| r["rootSessionId"] == turn_row["rootSessionId"])
        .count();
    let monitor = s.gw.get("/usage-monitor?since_hours=24").await?;
    let sessions = monitor.data()["topSessions"].as_array().unwrap();
    let listed: Vec<_> = sessions.iter().filter(|r| r["title"] == TITLE).collect();
    assert_eq!(listed.len(), 1, "{}", monitor.text);
    assert_eq!(listed[0]["kind"], "chat", "{}", monitor.text);
    assert_eq!(listed[0]["requests"], chat_rows, "{}", monitor.text);
    // Untitled rows are Butler's own work, never a conversation.
    for row in sessions.iter().filter(|r| r["title"].is_null()) {
        assert_eq!(row["kind"], "butler", "{row}");
    }
    s.finish().await
}
