use super::*;

async fn set_mode(s: &Scenario, mode: &str) -> Result<(), HarnessError> {
    let r =
        s.gw.patch("/sessions/general/controls", json!({"access_mode":mode}))
            .await?;
    assert_eq!(r.status, 200, "{r:?}");
    Ok(())
}
fn child_mode(s: &Scenario, child: &str) -> Result<String, HarnessError> {
    Ok(runtime(s)?.query_row("SELECT json_extract(context_json,'$.executionPolicy.accessMode') FROM btcc_turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1", [child], |r| r.get(0))?)
}
async fn changed_parent(mode: &str) -> Result<(), HarnessError> {
    let (url, script, server) = stub::start(false, true).await?;
    let (s, _) = setup("SS6-TIER", &url).await?;
    let initial = if mode == "ask_first" {
        "ask_except_reads"
    } else {
        "ask_first"
    };
    set_mode(&s, initial).await?;
    script.tier.store(true, std::sync::atomic::Ordering::SeqCst);
    let turn = accepted_turn_id(&s.gw.say("general", "Prepare evidence.").await?)?;
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
        .await?;
    let (relation, child): (String, String) = runtime(&s)?.query_row(
        "SELECT relation_id,child_session_id FROM btcc_session_relations",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(child_mode(&s, &child)?, initial);
    let binding: String =
        rusqlite::Connection::open(butler_turn::workspace::session_store_path(&s.sandbox.data))?
            .query_row(
                "SELECT metadata_json FROM session_bindings WHERE session_id=?1",
                [&child],
                |r| r.get(0),
            )?;
    assert_eq!(
        serde_json::from_str::<Value>(&binding)?["runtimePolicy"]["accessMode"],
        initial
    );
    set_mode(&s, mode).await?;
    assert_eq!(
        child_mode(&s, &child)?,
        initial,
        "running turn remains admitted"
    );
    script.release.add_permits(1);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let cards = s.gw.approval_requests("general").await?;
        if !cards.is_empty() {
            assert_eq!(
                cards[0]["approval"]["operation"]["command"],
                "printf reviewed"
            );
            crate::access_tiers::approve(&s, "general", "deny").await?;
            break;
        }
        assert!(Instant::now() < deadline, "child command did not ask");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    wait_count(&s, "work_result", 1).await?;
    *script.relation.lock().unwrap() = relation;
    let followup = accepted_turn_id(&s.gw.say("general", "Check again.").await?)?;
    s.gw.wait_terminal("general", &followup, Duration::from_secs(30))
        .await?;
    let expected = "ask_first";
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let n: i64 = runtime(&s)?.query_row(
            "SELECT count(*) FROM btcc_turns WHERE session_id=?1",
            [&child],
            |r| r.get(0),
        )?;
        if n >= 2 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "child followup did not start\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(child_mode(&s, &child)?, expected);
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn parent_raise_keeps_child_start_ceiling() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    changed_parent("full_access").await
}
#[tokio::test]
async fn parent_lower_narrows_next_child_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    changed_parent("ask_first").await
}
#[tokio::test]
async fn read_only_retains_existing_delegation_refusal() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false, true).await?;
    let (s, _) = setup("SS6-READONLY", &url).await?;
    set_mode(&s, "read_only").await?;
    let (_, turn) = s.turn("general", "Prepare evidence.").await?;
    assert_eq!(turn["state"], "delivered");
    let modes: Vec<String> = runtime(&s)?
        .prepare(
            "SELECT json_extract(packet_json,'$.access_mode') FROM btcc_subsession_delegations",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    if modes.is_empty() {
        let requests = script.requests.lock().unwrap();
        let refused = requests
            .iter()
            .flat_map(|r| r["input"].as_array().into_iter().flatten())
            .find(|item| item["type"] == "function_call_output" && item["call_id"] == "start-work")
            .expect("read-only delegation received a refusal");
        let result: Value = serde_json::from_str(refused["output"].as_str().unwrap())?;
        let result = result.get("output").unwrap_or(&result);
        assert!(!result["error"].is_null(), "{result}");
    } else {
        assert_eq!(modes, ["read_only"]);
        tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        let child: String = runtime(&s)?.query_row(
            "SELECT child_session_id FROM btcc_session_relations",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(child_mode(&s, &child)?, "read_only");
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn nested_worker_inherits_steward_and_parent_ceiling() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = crate::worker_cap::stub::start(2).await?;
    let s = Setup::new("SS6-NESTED-TIER")?
        .cassette("TOOL-01")
        .access(Access::AskExceptReads)
        .env("BUTLER_CHATGPT_API_BASE_URL", url)
        .start()
        .await?;
    s.gw.say("general", "Verify batch red").await?;
    let (_, workers) = crate::worker_cap::workers(&s, "general", 2).await?;
    crate::worker_cap::started(&script, 2).await;
    let db = runtime(&s)?;
    let mut statement = db.prepare(
        "SELECT json_extract(packet_json,'$.access_mode') FROM btcc_subsession_delegations",
    )?;
    let modes: Vec<String> = statement
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    assert_eq!(modes, vec!["ask_except_reads"; 3]);
    for row in workers {
        assert_eq!(
            child_mode(&s, row["session_id"].as_str().unwrap())?,
            "ask_except_reads"
        );
    }
    script.release("red-0");
    script.release("red-1");
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn pending_children_restart_with_current_parent_controls() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server) = crate::worker_cap::setup("SS6-QUEUED-RESTART", 4).await?;
    set_mode(&s, "ask_except_reads").await?;
    s.gw.say("general", "Verify batch red").await?;
    crate::worker_cap::workers(&s, "general", 3).await?;
    crate::worker_cap::started(&script, 2).await;
    script.fourth.add_permits(1);
    let (_, rows) = crate::worker_cap::workers(&s, "general", 4).await?;
    assert_eq!(rows[2]["status"], "waiting");
    assert_eq!(rows[3]["status"], "waiting");
    set_mode(&s, "ask_first").await?;
    s.agent.kill9()?;
    s.gw = s.agent.start_again().await?;
    crate::worker_cap::started(&script, 4).await;
    for row in &rows[2..] {
        assert_eq!(
            child_mode(&s, row["session_id"].as_str().unwrap())?,
            "ask_first"
        );
    }
    script.release("red-2");
    script.release("red-3");
    crate::worker_cap::closed(&s, rows[2]["session_id"].as_str().unwrap()).await?;
    crate::worker_cap::closed(&s, rows[3]["session_id"].as_str().unwrap()).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
