use super::*;

async fn unattended(child: bool, quiet: bool, files: bool) -> Result<(), HarnessError> {
    let (url, script, server) = stub::start(true, child).await?;
    script
        .file_actions
        .store(files, std::sync::atomic::Ordering::SeqCst);
    let (mut s, address) = setup("SS6-ATTENTION", &url).await?;
    let (target, notice) = if files {
        s.patch_settings(json!({"language":"en"}), "locale").await?;
        let folder = s.sandbox.root.join("projects");
        std::fs::create_dir_all(&folder)?;
        let target = crate::project_workspace::bind_project(&mut s, &folder).await?;
        (target, Some(folder.join("작업 Project/notice.txt")))
    } else {
        let chat =
            s.gw.post("/sessions", json!({"kind":"chat","title":"Scheduled work"}))
                .await?;
        (
            chat.data()["session"]["id"].as_str().unwrap().to_owned(),
            None,
        )
    };
    if quiet {
        clock(&address, "2026-10-28T06:59:59.000Z").await?;
    }
    let created = s.gw.post("/automations", json!({"title":"Evidence schedule","prompt_body":"Check evidence.","target_session_id":target,
        "schedule_type":"once","run_at":"2000-01-01T00:00:00.000Z","access_mode":"ask_first"})).await?;
    assert_eq!(created.status, 201, "{created:?}");
    let id = created.data()["automation"]["id"].as_str().unwrap();
    assert_eq!(
        s.gw.post("/automations/dispatch-due", json!({}))
            .await?
            .status,
        202
    );
    let deadline = Instant::now() + Duration::from_secs(90);
    let run = loop {
        let reply = s.gw.get(&format!("/automations/{id}/runs")).await?;
        if let Some(run) = reply.data()["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["state"] == "succeeded")
        {
            break run.clone();
        }
        assert!(Instant::now() < deadline, "{reply:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    let turn = run["turn_id"].as_str().unwrap();
    let finished =
        s.gw.wait_terminal(&target, turn, Duration::from_secs(30))
            .await?;
    assert_eq!(finished["state"], "delivered", "{finished}");
    if child {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let finished: bool = runtime(&s)?.query_row(
                "SELECT EXISTS(SELECT 1 FROM btcc_steward_results WHERE status='success')",
                [],
                |r| r.get(0),
            )?;
            if finished {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "unattended child did not finish its reply"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    if files {
        let distinct: i64 = app(&s)?.query_row(
            "SELECT count(*) FROM app_initiated_messages WHERE kind='approval_needed'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(
            distinct,
            2,
            "Three attempts contain two distinct exact actions; feedback={:?}",
            script
                .requests
                .lock()
                .unwrap()
                .iter()
                .flat_map(stub::outputs)
                .filter_map(|v| v["error"]["code"].as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        );
    }
    if quiet {
        held(&s, "approval_needed", 2).await?;
        assert_eq!(s.gw.messages("general").await?, [] as [Value; 0]);
        clock(&address, "2026-10-28T12:00:00.000Z").await?;
    }
    let rows = wait_count(&s, "approval_needed", 2).await?;
    if files {
        assert!(!notice.as_ref().unwrap().exists());
        for row in &rows {
            assert_eq!(
                row["initiated"]["approval"]["operation"]["tool"],
                "write_file"
            );
            assert!(
                row["initiated"]["approval"]["operation"]["targets"][0]
                    .as_str()
                    .unwrap()
                    .ends_with("notice.txt")
            );
        }
    } else {
        let mut commands: Vec<_> = rows
            .iter()
            .map(|m| {
                m["initiated"]["approval"]["operation"]["command"]
                    .as_str()
                    .unwrap()
            })
            .collect();
        commands.sort_unstable();
        assert_eq!(commands, ["printf first", "printf second"], "{rows:?}");
    }
    for row in rows {
        let origin = &row["initiated"];
        assert_eq!(origin["automation_id"], id);
        assert_eq!(origin["run_id"], run["id"]);
        assert_eq!(origin["automation_title"], "Evidence schedule");
        assert_eq!(origin["quiet"], false);
        assert!(row["text"].as_str().unwrap().starts_with(if files {
            "Needs your OK · Edit files · "
        } else {
            "확인 필요 · 네트워크 명령 실행 · "
        }));
        assert_eq!(
            origin["approval"]["action_kind"],
            if files {
                "edit_files"
            } else {
                "network_command"
            }
        );
        let text = row["text"].as_str().unwrap();
        let operation = &origin["approval"]["operation"];
        assert!(
            !text.contains(operation["tool"].as_str().unwrap()),
            "{text}"
        );
        if let Some(command) = operation["command"].as_str() {
            assert!(!text.contains(command), "{text}");
        }
        for target in operation["targets"].as_array().unwrap() {
            assert!(!text.contains(target.as_str().unwrap()), "{text}");
        }
        assert_eq!(origin["work_session_id"].is_string(), child);
        if child {
            let session: String = runtime(&s)?.query_row(
                "SELECT child_session_id FROM btcc_session_relations",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(origin["work_session_id"], session);
        }
    }
    assert_eq!(s.gw.approval_requests(&target).await?, Vec::<Value>::new());
    assert_eq!(
        runtime(&s)?.query_row("SELECT count(*) FROM btcc_authority_requests", [], |r| r
            .get::<_, i64>(0))?,
        0
    );
    let feedback: Vec<_> = script
        .requests
        .lock()
        .unwrap()
        .iter()
        .flat_map(stub::outputs)
        .filter(|v| v["error"]["code"] == "schedule_permission_required")
        .collect();
    assert!(feedback.len() >= 3, "{feedback:?}");
    assert_eq!(
        app(&s)?.query_row(
            "SELECT count(*) FROM app_initiated_messages WHERE kind='approval_needed'",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        2
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn unattended_exact_actions_deduplicate_and_continue() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    unattended(false, false, false).await
}
#[tokio::test]
async fn unattended_child_attention_is_held_in_quiet_hours() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    unattended(true, true, false).await
}

#[tokio::test]
async fn same_target_distinct_inputs_remain_distinct_actions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    unattended(false, false, true).await
}

fn browser_cassette() -> Result<butler_e2e::e2e::cassette::Cassette, HarnessError> {
    use butler_e2e::e2e::cassette::Cassette;
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    for request in ["Review this browser action.", "Check the browser action."] {
        let mut round = Vec::new();
        for (index, (name, args)) in [
            ("tool_describe", json!({"ids":["native:browser_act"]})),
            ("tool_call", json!({"id":"native:browser_act","arguments":{
                "tab":"pub","observation":"obs-1","steps":[{"action":"click","ref":"e9","commits":true}]}})),
        ].into_iter().enumerate() {
            let mut exchange = template.exchanges[0].clone();
            exchange.request.key.user_request = request.into();
            exchange.request.key.round = round.clone();
            exchange.response = crate::browser_usage::stub::response(&json!({
                "type":"function_call","id":format!("browser-{index}"),"call_id":format!("browser-{index}"),
                "name":name,"arguments":args.to_string(),"status":"completed"}));
            cassette.exchanges.push(exchange);
            round.extend(["function_call".into(), "function_call_output".into()]);
        }
        let mut exchange = template.exchanges[1].clone();
        exchange.request.key.user_request = request.into();
        exchange.request.key.round = round;
        exchange.response = crate::browser_usage::stub::response(
            &json!({"type":"message","id":"done",
            "role":"assistant","status":"completed","content":[{"type":"output_text","text":"Handled.","annotations":[]}]}),
        );
        cassette.exchanges.push(exchange);
    }
    Ok(cassette)
}

#[tokio::test]
async fn skipped_browser_approval_matches_the_interactive_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SS6-BROWSER-ATTENTION")?
        .access(Access::AskExceptReads)
        .stub_cassette(browser_cassette()?)
        .clock_after_daily_jobs("2026-10-27T12:00:00.000Z")?
        .start()
        .await?;
    s.patch_settings(
        json!({"timezone":"UTC","quiet_hours_start":"01:00","quiet_hours_end":"02:00"}),
        "clock",
    )
    .await?;
    let _host = crate::browser_approval::host::Host::attach(&s).await?;
    let id =
        s.gw.say_turn("general", "Review this browser action.")
            .await?;
    s.gw.wait_turn(
        "general",
        &id,
        &["waiting_for_form"],
        Duration::from_secs(30),
    )
    .await?;
    let cards = s.gw.approval_requests("general").await?;
    assert_eq!(cards.len(), 1);
    let card = &cards[0];
    let reference = card["request_ref"].as_str().unwrap();
    assert_eq!(
        s.gw.post(
            &format!("/authority-requests/{reference}/deny?session_id=general"),
            json!({})
        )
        .await?
        .status,
        202
    );
    s.gw.wait_terminal("general", &id, Duration::from_secs(30))
        .await?;
    let created = s.gw.post("/automations", json!({"title":"Browser check","prompt_body":"Check the browser action.",
        "target_session_id":"general","schedule_type":"once","run_at":"2000-01-01T00:00:00Z","access_mode":"ask_first","browser_payment":true})).await?;
    assert_eq!(created.status, 201, "{created:?}");
    assert_eq!(
        s.gw.post("/automations/dispatch-due", json!({}))
            .await?
            .status,
        202
    );
    let rows = wait_count(&s, "approval_needed", 1).await?;
    assert_eq!(rows[0]["initiated"]["approval"], card["approval"]);
    assert!(!rows[0]["text"].as_str().unwrap().contains("browser_act"));
    let label = rows[0]["initiated"]["label"].as_str().unwrap();
    assert_ne!(label, "");
    assert!(rows[0]["text"].as_str().unwrap().contains(label));
    assert_eq!(s.gw.approval_requests("general").await?, [] as [Value; 0]);
    s.finish().await
}
