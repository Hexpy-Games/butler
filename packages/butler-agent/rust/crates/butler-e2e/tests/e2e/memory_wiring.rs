//! Audit regressions: real service, fresh DATA, no seeded memory state.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::faults::{ArgsMutation, mutate_chunk};
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, fixtures};
use serde_json::{Value, json};
use std::path::Path;

// A watchdog around persisted completion barriers, not a latency assertion.
// Yield without sleeping; elapsed time is never evidence of completion.
async fn until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("production owner did not publish its completion marker");
}

pub(super) async fn bootstrap(data: &Path) {
    until(|| {
        data.join("cognition/memory/active-generation.json")
            .exists()
    })
    .await;
}

async fn mcp_graph(s: &Scenario) -> Result<Value, HarnessError> {
    butler_e2e::e2e::mcp::tool(
        &s.agent.launch,
        &s.sandbox.logs.join("memory-graph-mcp.log"),
        json!({"name":"memory-wiring-audit","version":"0"}),
        "memory_graph",
        json!({"query":"garden","hops":1}),
    )
    .await
}

/// The retained MCP graph query must work on a production fresh generation.
#[tokio::test]
async fn wiring_mcp_graph_accepts_fresh_generation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("WIRING-MCP-GRAPH")?.fixture(Fixture::Empty);
    assert!(!setup.sandbox.data.join("cognition").exists());
    let s = setup.start().await?;
    bootstrap(&s.sandbox.data).await;
    let descriptor: Value = serde_json::from_slice(&std::fs::read(
        s.sandbox
            .data
            .join("cognition/memory/active-generation.json"),
    )?)?;
    let graph_path = s
        .sandbox
        .data
        .join("cognition/memory/generations")
        .join(descriptor["generation_id"].as_str().unwrap())
        .join("graph.sqlite");
    let before = std::fs::read(&graph_path)?;
    let reply = mcp_graph(&s).await?;
    assert_eq!(
        std::fs::read(&graph_path)?,
        before,
        "MCP mutated the serving graph"
    );
    assert!(!s.sandbox.data.join("cognition/memory/db").exists());
    assert!(reply["error"].is_null(), "MCP protocol error: {reply}");
    let text = reply["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned();
    eprintln!("WIRING-MCP-GRAPH result={text}");
    s.finish().await?;
    let graph = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| {
        panic!("fresh production memory cannot be queried through MCP: {text}")
    });
    assert!(
        graph["entities"].is_array() && graph["relationships"].is_array(),
        "{graph}"
    );
    Ok(())
}

fn status_memory_tokens(s: &Scenario) -> Result<u64, HarnessError> {
    let output = s.agent.launch.command().arg("status").output()?;
    assert!(output.status.success(), "status command failed");
    let text = String::from_utf8(output.stdout).expect("status output is not UTF-8");
    let count = text
        .lines()
        .find_map(|line| line.strip_prefix("memory: "))
        .expect("status omitted memory estimate")
        .replace(',', "")
        .parse()
        .expect("status memory estimate is not a token count");
    Ok(count)
}

/// A user saves a rule successfully; native status must count that memory.
#[tokio::test]
async fn wiring_status_counts_saved_explicit_memory() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let cassette = Cassette::load("MEM-01")?;
    let remember = cassette.exchanges[0].request.key.user_request.clone();
    let setup = Setup::new("WIRING-STATUS")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette)
        .placeholder("NONCE", "5317");
    // Only onboarding is completed; no memory initializer, graph, cache,
    // embedding assets or rules are provided by the harness.
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    assert!(!setup.sandbox.data.join("cognition").exists());
    let s = setup.start().await?;
    s.select_model(&s.model).await?;
    bootstrap(&s.sandbox.data).await;
    let before = status_memory_tokens(&s)?;
    let (_, turn) = s
        .turn("general", &remember.replace("{{NONCE}}", "5317"))
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let rules = s.sandbox.data.join("cognition/memory/rules");
    let index = std::fs::read_to_string(rules.join("INDEX.md"))?;
    assert!(index.contains("5317"), "explicit memory was not saved");
    let after = status_memory_tokens(&s)?;
    assert!(!s.sandbox.data.join("memory/rules/INDEX.md").exists());
    assert!(!s.sandbox.data.join("memory/hot/cache.md").exists());
    let minimum_added = index.encode_utf16().count().div_ceil(4) as u64;
    eprintln!(
        "WIRING-STATUS before={before} after={after} saved_rule_index_tokens={minimum_added}"
    );
    s.finish().await?;
    assert!(
        after >= before + minimum_added,
        "native status ignores production memory: before={before}, after={after}, saved index needs at least {minimum_added} tokens"
    );
    Ok(())
}

/// Project-bound rules must not become mandatory rules in unrelated chats.
#[tokio::test]
async fn wiring_project_rule_stays_out_of_general_prompt() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("MEM-01")?;
    let remember = "For this project only, always use planter label audit-garden-{{NONCE}}. Save this as an explicit rule using your memory tool.";
    let mutation = ArgsMutation::Replace {
        from: "The user's bike lock code is {{NONCE}}.".into(),
        to: "For this project only, use planter label audit-garden-{{NONCE}}.".into(),
    };
    for chunk in &mut cassette.exchanges[0].response.chunks {
        chunk.text = mutate_chunk(&chunk.text, &mutation);
    }
    for exchange in &mut cassette.exchanges {
        exchange.request.key.user_request = remember.into();
    }
    let ask = "Say hello in one sentence.";
    // Reuse only the recorded text response as a deterministic stub. This
    // turn makes no tool call and contains none of the project's memory text.
    let mut answer = cassette.exchanges[1].clone();
    answer.request.key.user_request = ask.into();
    answer.request.key.round.clear();
    cassette.exchanges.push(answer);
    let setup = Setup::new("WIRING-RULE-SCOPE")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette)
        .placeholder("NONCE", "5317");
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    assert!(!setup.sandbox.data.join("cognition").exists());
    let s = setup.start().await?;
    s.select_model(&s.model).await?;
    bootstrap(&s.sandbox.data).await;
    let reply =
        s.gw.post(
            "/projects",
            json!({
                "source":"scratch", "display_name":"Private garden"
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let project = reply.data()["project"]["id"].as_str().unwrap().to_owned();
    let reply =
        s.gw.post(
            "/sessions",
            json!({
                "kind":"project", "title":"Project memory", "project_id":project
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let chat = reply.data()["session"]["id"].as_str().unwrap();
    let (_, turn) = s.turn(chat, &remember.replace("{{NONCE}}", "5317")).await?;
    assert_eq!(
        turn["state"],
        "delivered",
        "{turn}; replay misses: {:?}",
        s.provider()?.misses()
    );
    let rules = s.sandbox.data.join("cognition/memory/rules");
    assert!(std::fs::read_to_string(rules.join("INDEX.md"))?.contains("For this project only"));
    let binding_path = std::fs::read_dir(&rules)?
        .map(Result::unwrap)
        .map(|entry| entry.path())
        .find(|path| path.to_string_lossy().ends_with(".source.json"))
        .unwrap();
    let binding: Value = serde_json::from_slice(&std::fs::read(binding_path)?)?;
    assert_eq!(
        binding["project_id"], project,
        "writer lost project provenance"
    );
    let first = s.provider()?.requests().len();
    let (_, turn) = s.turn(chat, ask).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let scoped = requests[first..]
        .iter()
        .find(|request| request["reasoning"]["effort"] == "max")
        .expect("project chat made no foreground request")["input"]
        .to_string();
    assert!(
        scoped
            .split("## Active Rules")
            .nth(1)
            .and_then(|section| section.split("\\n## ").next())
            .is_some_and(|section| section.contains("5317"))
    );
    let first = s.provider()?.requests().len();
    let (_, turn) = s.turn("general", ask).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let prompt = requests[first..]
        .iter()
        .find(|request| request["reasoning"]["effort"] == "max")
        .expect("general chat made no foreground model request")["input"]
        .to_string();
    let leaked = prompt
        .split("## Active Rules")
        .nth(1)
        .and_then(|section| section.split("\\n## ").next())
        .is_some_and(|section| section.contains("5317"));
    eprintln!(
        "WIRING-RULE-SCOPE project_binding=true general_active_rules_contains_project_fact={leaked}"
    );
    s.finish().await?;
    assert!(
        !leaked,
        "a project-bound rule was injected into an unrelated general chat's mandatory Active Rules"
    );
    Ok(())
}

/// A daily fold publishes a project page for subsequent chats in that project.
#[tokio::test]
async fn wiring_daily_project_page_reaches_project_chat() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    const NOW: &str = "2026-10-02T04:01:00.000Z";
    const DECISION: &str = "We ship the garden app as a web app only.";
    let server = FakeServer::local_models(ChatBehavior {
        answer: json!({"status":"processed","entities":[],"items":[
            {"kind":"decision","subject":null,"text":DECISION,"evidence":[0]}
        ],"attributes":[]})
        .to_string(),
        chunk_delay: std::time::Duration::ZERO,
        ..ChatBehavior::default()
    })
    .await?;
    let setup = Setup::new("WIRING-PROJECT-PAGE")?
        .fixture(Fixture::Empty)
        .env("BUTLER_E2E_APP_NOW", NOW)
        .env(
            "BUTLER_E2E_EMBED_MANIFEST",
            format!("{}/unavailable", server.base_url),
        );
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, NOW)?;
    let mut s = setup.start().await?;
    bootstrap(&s.sandbox.data).await;
    let data = s.sandbox.data.clone();
    let memory = data.join("cognition/memory");
    let descriptor: Value =
        serde_json::from_slice(&std::fs::read(memory.join("active-generation.json"))?)?;
    let generation = memory
        .join("generations")
        .join(descriptor["generation_id"].as_str().unwrap());
    let graph = generation.join("graph.sqlite");
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
    let model = reply.data()["model"]["model_ref"].as_str().unwrap();
    let reply =
        s.gw.patch(
            "/settings",
            json!({
                "model":model,"consolidation_model":model,"access_mode":"full_access"
            }),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let reply =
        s.gw.post(
            "/projects",
            json!({
                "source":"scratch","display_name":"Audit garden"
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let project = reply.data()["project"]["id"].as_str().unwrap().to_owned();
    let reply =
        s.gw.post(
            "/sessions",
            json!({
                "kind":"project","title":"Garden notes","project_id":project
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let chat = reply.data()["session"]["id"].as_str().unwrap();
    let (first_turn, turn) = s.turn(chat, DECISION).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let db = butler_platform::sqlite::open_with_flags(
        &graph,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    until(|| {
        db.query_row(
            "SELECT COUNT(*) FROM memory_chunks WHERE source_key=?1 AND summary_status='complete'",
            [format!("conversation_turn:{first_turn}")],
            |row| row.get::<_, u64>(0),
        )
        .unwrap()
            == 1
    })
    .await;
    drop(db);

    s.agent.terminate().await?;
    for job in ["session-sync", "consolidation-cycle"] {
        std::fs::remove_file(data.join(format!("state/scheduler/{job}.json")))?;
    }
    super::memory_fixture::arm_consolidation(&data, "2026-10-02T03:59:00.000Z")?;
    s.gw = s.agent.start_again().await?;
    let marker = data.join("state/scheduler/consolidation-cycle.json");
    until(|| {
        std::fs::read(&marker)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|state| state["lastRunDate"] == NOW[..10])
    })
    .await;
    assert!(server.chat_requests().iter().any(|request| {
        let text = request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|message| message["content"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        text.contains("You keep a short page about one project")
            && text.contains("Current page (0 bytes; keep it under 3,000)")
            && text
                .lines()
                .any(|line| line.ends_with(&format!("user decision] {DECISION}")))
    }));
    let page = generation
        .join("hot/projects")
        .join(format!("{project}.md"));
    assert_eq!(
        butler_platform::secure_fs::is_owner_only(&std::fs::metadata(&page)?),
        butler_platform::secure_fs::OWNER_ONLY.then_some(true),
        "project page privacy"
    );
    assert!(std::fs::read_to_string(&page)?.starts_with("<!-- butler-standing {\"v\":3"));
    let events: Vec<Value> = std::fs::read_dir(data.join("cognition/consolidation/logs"))?
        .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
        .flat_map(|text| {
            text.lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect::<Vec<Value>>()
        })
        .collect();
    let folds: Vec<_> = events
        .iter()
        .filter(|event| event["phase"] == "project_page")
        .collect();
    assert_eq!(folds.len(), 1, "{events:?}");
    assert_eq!(folds[0]["project_id"], project);
    assert_eq!(folds[0]["status"], "ok");
    assert_eq!(folds[0]["metrics"]["calls"], 1);
    assert!(folds[0]["metrics"]["sources_folded"].as_u64().unwrap() >= 1);
    let health = events
        .iter()
        .find(|event| event["phase"] == "health")
        .unwrap();
    assert!(
        health["metrics"]
            .get("project_capsules_considered")
            .is_none()
    );

    let (project_turn, turn) = s.turn(chat, "What did we decide about platforms?").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let (general_turn, turn) = s.turn("general", "Say hello.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let db = butler_platform::sqlite::open_with_flags(
        data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut query = db.prepare(
        "SELECT d.content FROM btcc_turns t, json_each(t.context_json, '$.optionalHotCacheRefs') r JOIN btcc_context_documents d ON d.context_ref=r.value WHERE t.turn_id=?1 AND d.source_id='project-memory'"
    ).unwrap();
    let documents: Vec<String> = query
        .query_map([project_turn], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(documents.len(), 1);
    assert!(documents[0].starts_with(
        "## Project Memory\n\nWhat Butler keeps about this project from earlier chats in it."
    ));
    assert!(
        query
            .query([general_turn])
            .unwrap()
            .next()
            .unwrap()
            .is_none()
    );
    let view = s.gw.get(&format!("/memory/projects/{project}")).await?;
    assert!(view.data()["summary_bytes"].as_u64().unwrap() > 0);
    s.finish().await?;
    Ok(())
}
