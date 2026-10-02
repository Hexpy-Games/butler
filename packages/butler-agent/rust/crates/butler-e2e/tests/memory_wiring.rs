//! Audit regressions: real service, fresh DATA, no seeded memory state.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::faults::{ArgsMutation, mutate_chunk};
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, fixtures};
use serde_json::{Value, json};
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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

async fn bootstrap(data: &Path) {
    until(|| {
        data.join("cognition/memory/active-generation.json")
            .exists()
    })
    .await;
}

async fn mcp_graph(s: &Scenario) -> Result<Value, HarnessError> {
    let mut command = tokio::process::Command::from(s.agent.launch.command());
    command
        .args(["mcp", "serve"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(
            s.sandbox.logs.join("memory-graph-mcp.log"),
        )?)
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    let mut replies = BufReader::new(child.stdout.take().unwrap()).lines();
    let messages = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},
            "clientInfo":{"name":"memory-wiring-audit","version":"0"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
            "name":"memory_graph","arguments":{"query":"garden","hops":1}}}),
    ];
    let mut result = Value::Null;
    for message in messages {
        stdin.write_all(format!("{message}\n").as_bytes()).await?;
        stdin.flush().await?;
        let Some(id) = message["id"].as_u64() else {
            continue;
        };
        result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while let Some(line) = replies.next_line().await? {
                let reply: Value = serde_json::from_str(&line)?;
                if reply["id"] == id {
                    return Ok::<_, HarnessError>(reply);
                }
            }
            Err(butler_e2e::e2e::harness_error(
                "MCP closed before its reply",
            ))
        })
        .await
        .expect("MCP did not answer")?;
    }
    drop(stdin);
    if tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
        .await
        .is_err()
    {
        child.kill().await?;
        child.wait().await?;
    }
    Ok(result)
}

/// The retained MCP graph query must work on a production fresh generation.
#[tokio::test]
async fn wiring_mcp_graph_accepts_fresh_generation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("WIRING-MCP-GRAPH")?.fixture(Fixture::Empty);
    assert!(!setup.sandbox.data.join("cognition").exists());
    let s = setup.start().await?;
    bootstrap(&s.sandbox.data).await;
    let reply = mcp_graph(&s).await?;
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

fn configured_health(data: &Path) -> Option<Value> {
    let logs = std::fs::read_dir(data.join("cognition/consolidation/logs")).ok()?;
    logs.filter_map(Result::ok)
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .flat_map(|text| text.lines().map(str::to_owned).collect::<Vec<_>>())
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .find(|event| event["phase"] == "health" && event["status"] == "ok")
}

/// App registration must feed the daily project-memory capsule refresh.
#[tokio::test]
async fn wiring_daily_capsule_includes_app_registered_project() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("WIRING-CAPSULE")?.fixture(Fixture::Empty);
    assert!(!setup.sandbox.data.join("cognition").exists());
    let mut s = setup.start().await?;
    bootstrap(&s.sandbox.data).await;
    let reply =
        s.gw.post(
            "/projects",
            json!({
                "source":"scratch", "display_name":"Audit garden"
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let project = reply.data()["project"]["id"].as_str().unwrap().to_owned();
    let reply =
        s.gw.post(
            "/sessions",
            json!({
                "kind":"project", "title":"Garden notes", "project_id":project
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let listed = s.gw.get("/projects").await?;
    assert_eq!(listed.status, 200, "{}", listed.text);
    assert!(
        listed.text.contains(&project),
        "App lost its registered project"
    );

    // Advance the supported stub clock and restart: the first maintenance
    // tick runs after 04:00. No fabricated daily completion marker is supplied.
    s.agent
        .launch
        .set_env("BUTLER_E2E_APP_NOW", "2026-10-02T04:01:00.000Z");
    s.restart().await?;
    let marker = s
        .sandbox
        .data
        .join("state/scheduler/consolidation-cycle.json");
    until(|| {
        std::fs::read(&marker)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|state| state["lastRunDate"] == "2026-10-02")
    })
    .await;
    let health = configured_health(&s.sandbox.data)
        .expect("configured health phase must complete before inspecting capsule coverage");
    let capsule = s
        .sandbox
        .data
        .join("cognition/memory/projects")
        .join(format!("{project}.md"));
    let present = capsule.exists();
    eprintln!(
        "WIRING-CAPSULE registered=1 considered={} refreshed={} capsule_present={present}",
        health["metrics"]["project_capsules_considered"],
        health["metrics"]["project_capsules_refreshed"]
    );
    s.finish().await?;
    assert!(
        present,
        "daily health completed but the App project's capsule is missing: {health}"
    );
    assert_eq!(health["metrics"]["project_capsules_considered"], 1);
    assert_eq!(health["metrics"]["project_capsules_refreshed"], 1);
    Ok(())
}
