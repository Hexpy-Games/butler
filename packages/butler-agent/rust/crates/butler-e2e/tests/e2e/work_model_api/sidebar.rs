use super::*;

async fn link(s: &Scenario, id: &Value) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.post(
            &format!("/canon/epics/{}/conversation", id.as_str().unwrap()),
            json!({}),
        )
        .await?,
        200,
    ))
}
async fn sidebar(s: &Scenario, project: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.get(&format!("/projects/{project}/canon/sidebar"))
            .await?,
        200,
    ))
}
#[tokio::test]
async fn wma_sidebar_conversation_navigation_and_replay() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("WMA-SIDEBAR-LINK")?;
    let hook_output = setup.sandbox.home.join("session-start.jsonl");
    let extension = if butler_platform::command_sandbox::POSIX_SHELL {
        "sh"
    } else {
        "cmd"
    };
    let observer =
        butler_e2e::e2e::binary::crate_root().join(format!("tests/e2e/hooks/observe.{extension}"));
    let args = if extension == "sh" {
        vec!["sh".to_owned(), observer.to_string_lossy().into_owned()]
    } else {
        vec![
            "cmd.exe".into(),
            "/d".into(),
            "/s".into(),
            "/c".into(),
            observer.to_string_lossy().into_owned(),
        ]
    };
    std::fs::write(
        setup.sandbox.data.join("hooks.json"),
        json!({"version":1,"hooks":[{
            "id":"observe-session", "event":"SessionStart", "type":"command", "args":args,
            "env":{"HOOK_OUTPUT":hook_output}, "timeout_ms":3000
        }]})
        .to_string(),
    )?;
    let mut s = setup.start().await?;
    let project = project(&s).await?;
    let work = create_epic(&s, &project, "Conversation navigation").await?;
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let (a, b) = tokio::join!(link(&s, &work["id"]), link(&s, &work["id"]));
    let a = a?;
    assert_eq!(a["session_id"], b?["session_id"]);
    assert_eq!(a["work"]["sessions"][0]["session_id"], a["session_id"]);
    let chat = a["session_id"].as_str().unwrap();
    let session = data(
        s.gw.get(&format!("/project-sessions?project_id={project}"))
            .await?,
        200,
    );
    assert!(session.to_string().contains(&project));
    assert!(session.to_string().contains("Conversation navigation"));
    event(&stream, "canon.changed", work["id"].as_str().unwrap()).await?;
    let nav = data(s.gw.get("/navigation").await?, 200);
    assert!(
        !nav["space"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["entity_id"] == chat || n["entityId"] == chat)
    );
    // Recent/running use these full session summaries; only tree membership changes.
    assert!(nav["projects"].to_string().contains(chat));
    let sessions = data(
        s.gw.get(&format!("/sessions?project_id={project}")).await?,
        200,
    );
    assert!(sessions.to_string().contains(chat));
    let search = data(s.gw.get("/command-palette?query=Conversation").await?, 200);
    assert!(search.to_string().contains(chat));
    let missing =
        s.gw.post("/canon/epics/missing/conversation", json!({}))
            .await?;
    assert_eq!(missing.status, 404);
    let hooks = match std::fs::read_to_string(&hook_output) {
        Ok(hooks) => hooks,
        Err(error) => {
            let admin = butler_e2e::e2e::security::AdminClient::new(
                s.gw.clone(),
                s.agent.launch.admin_credential().unwrap(),
            );
            let runs = admin
                .send(reqwest::Method::GET, "/hooks/runs", None, &[])
                .await?;
            return Err(HarnessError(format!("{error}; hooks: {}", runs.text)));
        }
    };
    let hooks: Vec<Value> = hooks
        .trim_start_matches('\u{feff}')
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(hooks.iter().filter(|h| h["source"] == "created").count(), 1);
    let other = create_epic(&s, &project, "Another work").await?;
    s.agent.terminate().await?;
    let output = tokio::process::Command::new(butler_e2e::e2e::binary::fixture_binary(
        "e2e-canon-conversation",
    )?)
    .kill_on_drop(true)
    .arg(s.sandbox.data.join("agent-runtime/btcc.sqlite"))
    .args([work["id"].as_str().unwrap(), other["id"].as_str().unwrap()])
    .output()
    .await?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // Simulate a crash between the BTCC commit and App projection commit.
    let app_db =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let plan: String = app_db.query_row(
        "EXPLAIN QUERY PLAN SELECT 1 FROM app_canon_conversations cc WHERE cc.session_id=?1",
        [chat],
        |row| row.get(3),
    )?;
    assert!(plan.contains("SEARCH cc"), "{plan}");
    app_db.execute("DELETE FROM app_canon_conversations", [])?;
    drop(app_db);
    let btcc = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    btcc.execute(
        "UPDATE canon_intents SET state='pending' WHERE kind='canon_conversation'",
        [],
    )?;
    // The first receipt is terminally invalid; the following one still creates a chat.
    let owner = "butler/app-replay-conversation";
    let pending = json!({"session_id":owner,"work_id":other["id"],"project_id":project,"title":"Replayed chat"});
    for (op, payload) in [
        (
            "000-deleted",
            json!({"session_id":"butler/app-deleted","work_id":"deleted-work","project_id":project}),
        ),
        (
            "000-project-deleted",
            json!({"session_id":"butler/app-deleted-project","work_id":other["id"],"project_id":"deleted-project"}),
        ),
        ("001-replay", pending),
    ] {
        btcc.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,revision,created_at) VALUES(?1,'canon_conversation',?2,'pending',0,0)", rusqlite::params![op,payload.to_string()])?;
    }
    btcc.execute(
        "INSERT OR IGNORE INTO canon_session_epics(session_id,epic_id,bound_at,bound_by,origin,is_home) VALUES(?1,?2,0,'{}','user',1)",
        rusqlite::params![owner, other["id"].as_str()],
    )?;
    drop(btcc);
    s.restart().await?;
    let recovered = LiveEvents::subscribe(&s.gw, 0).await?;
    recovered
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "space.changed"
                && e["payload"]["revision"]
                    .as_i64()
                    .is_some_and(|v| v > nav["space"]["revision"].as_i64().unwrap())
        })
        .await?;
    assert_eq!(link(&s, &work["id"]).await?["session_id"], a["session_id"]);
    let replayed = data(
        s.gw.get(&format!("/sessions?project_id={project}")).await?,
        200,
    );
    assert!(replayed.to_string().contains("Replayed chat"));
    // Replay commits the chat before dispatching its lifecycle hook.
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let hooks = std::fs::read_to_string(&hook_output).unwrap_or_default();
            if hooks
                .trim_start_matches('\u{feff}')
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(|h| h["source"] == "created")
                .count()
                >= 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| std::io::Error::other("replay session hook missing"))?;
    let hooks = std::fs::read_to_string(&hook_output)?;
    let hooks: Vec<Value> = hooks
        .trim_start_matches('\u{feff}')
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(hooks.iter().filter(|h| h["source"] == "created").count(), 2);
    s.agent.terminate().await?;
    let btcc = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let pending: i64 = btcc.query_row(
        "SELECT count(*) FROM canon_intents WHERE kind='canon_conversation' AND state='pending'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(pending, 0);
    drop(btcc);
    s.finish().await
}
#[tokio::test]
async fn wma_sidebar_personal_order_preserves_canon() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("WMA-SIDEBAR-ORDER")?.start().await?;
    let project = project(&s).await?;
    let plan = create_plan(&s, &project, "A plan").await?;
    let a = create_epic(&s, &project, "A").await?;
    let b = create_epic(&s, &project, "B").await?;
    let hidden = create_epic(&s, &project, "Hidden").await?;
    link(&s, &a["id"]).await?;
    data(
        s.gw.patch(
            &format!("/canon/epics/{}", b["id"].as_str().unwrap()),
            json!({"expected_revision":b["revision"],"assignee":"app-user"}),
        )
        .await?,
        200,
    );
    let initial = overview(&s, &project).await?;
    let view = sidebar(&s, &project).await?;
    assert_eq!(view["groups"][0]["kind"], "backlog");
    assert!(view["groups"][0]["title"].is_null());
    assert_eq!(view["groups"][1]["key"], plan["id"]);
    assert_eq!(
        ids(&view["groups"][0]["rows"]),
        vec![a["id"].as_str().unwrap(), b["id"].as_str().unwrap()]
    );
    let path = format!("/projects/{project}/canon/sidebar-order");
    let input = json!({"group_key":"backlog","work_ids":[b["id"],a["id"]]});
    for _ in 0..2 {
        data(s.gw.post(&path, input.clone()).await?, 200);
    }
    let forward = json!({"group_key":"backlog","work_ids":[a["id"],b["id"]]});
    let changed = data(s.gw.post(&path, forward).await?, 200);
    assert_eq!(
        ids(&changed["groups"][0]["rows"]),
        vec![a["id"].as_str().unwrap(), b["id"].as_str().unwrap()]
    );
    data(s.gw.post(&path, input.clone()).await?, 200);
    assert_eq!(overview(&s, &project).await?, initial);
    assert_eq!(
        sidebar(&s, &project).await?["groups"][0]["rows"][0]["id"],
        b["id"]
    );
    s.restart().await?;
    assert_eq!(
        sidebar(&s, &project).await?["groups"][0]["rows"][0]["id"],
        b["id"]
    );
    let c = create_epic(&s, &project, "C").await?;
    link(&s, &c["id"]).await?;
    assert_eq!(
        ids(&sidebar(&s, &project).await?["groups"][0]["rows"]),
        vec![
            b["id"].as_str().unwrap(),
            a["id"].as_str().unwrap(),
            c["id"].as_str().unwrap()
        ]
    );
    let stale = s.gw.post(&path, input).await?;
    assert_eq!(stale.status, 409);
    assert_eq!(stale.error_code(), Some("conflict"));
    assert!(stale.body["error"]["current"]["revision"].is_i64());
    let stale =
        s.gw.post(
            &path,
            json!({"group_key":"backlog","work_ids":[hidden["id"]]}),
        )
        .await?;
    assert_eq!(stale.status, 409);
    let malformed =
        s.gw.post(
            &path,
            json!({"group_key":"backlog","work_ids":[a["id"],a["id"]]}),
        )
        .await?;
    assert_eq!(malformed.status, 400);
    s.agent.terminate().await?;
    let btcc = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        btcc.execute(
            "DELETE FROM canon_plans WHERE id=?1",
            [plan["id"].as_str().unwrap()]
        )?,
        1
    );
    drop(btcc);
    s.restart().await?;
    assert!(
        sidebar(&s, &project).await?["groups"]
            .as_array()
            .unwrap()
            .iter()
            .all(|g| g["key"] != plan["id"])
    );
    let deleted =
        s.gw.post(&path, json!({"group_key":plan["id"],"work_ids":[]}))
            .await?;
    assert_eq!(deleted.status, 409);
    assert_eq!(deleted.error_code(), Some("conflict"));
    let malformed =
        s.gw.post(&path, json!({"group_key":plan["id"],"work_ids":"invalid"}))
            .await?;
    assert_eq!(malformed.status, 400);
    s.finish().await
}

#[tokio::test]
async fn wma_sidebar_links_wait_for_creation_hook() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("WMA-SIDEBAR-HOOK-WAIT")?;
    let (held, release) = hold_creation_hook(&setup)?;
    let s = setup.start().await?;
    // Release before the scenario shuts down, including assertion failures.
    let release = HookRelease(release);
    let project = project(&s).await?;
    let work = create_epic(&s, &project, "Creation hook admission").await?;
    {
        let first = link(&s, &work["id"]);
        tokio::pin!(first);
        let held_wait = async {
            while !held.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        tokio::select! {
            result = &mut first => panic!("link returned before its creation hook completed: {result:?}"),
            result = tokio::time::timeout(Duration::from_secs(20), held_wait) => {
                result.map_err(|_| HarnessError("creation hook did not start".into()))?;
            }
        }
        let second = link(&s, &work["id"]);
        tokio::pin!(second);
        let early = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::select! {
                result = &mut first => result,
                result = &mut second => result,
            }
        })
        .await;
        assert!(
            early.is_err(),
            "link returned while its creation hook was held: {early:?}"
        );
        std::fs::write(&release.0, b"")?;
        let (first, second) = tokio::join!(first, second);
        assert_eq!(first?["session_id"], second?["session_id"]);
    }
    drop(release);
    s.finish().await
}

struct HookRelease(std::path::PathBuf);
impl Drop for HookRelease {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.0, b"");
    }
}

fn hold_creation_hook(
    setup: &Setup,
) -> Result<(std::path::PathBuf, std::path::PathBuf), HarnessError> {
    let held = setup.sandbox.home.join("hook-held");
    let release = setup.sandbox.home.join("hook-release");
    let extension = if butler_platform::command_sandbox::POSIX_SHELL {
        "sh"
    } else {
        "cmd"
    };
    let fixture =
        butler_e2e::e2e::binary::crate_root().join(format!("tests/e2e/hooks/hold.{extension}"));
    let args = if extension == "sh" {
        vec!["sh".to_owned(), fixture.to_string_lossy().into_owned()]
    } else {
        vec![
            "cmd.exe".into(),
            "/d".into(),
            "/s".into(),
            "/c".into(),
            fixture.to_string_lossy().into_owned(),
        ]
    };
    std::fs::write(
        setup.sandbox.data.join("hooks.json"),
        json!({
            "version":1,"hooks":[{"id":"hold-session","event":"SessionStart",
            "type":"command","args":args,"timeout_ms":60000,
            "env":{"HOOK_HELD":held,"HOOK_RELEASE":release}}]
        })
        .to_string(),
    )?;
    Ok((held, release))
}

#[tokio::test]
async fn wma_sidebar_different_intents_do_not_wait_for_creation_hook() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("WMA-SIDEBAR-INDEPENDENT-HOOK")?;
    let (held, release) = hold_creation_hook(&setup)?;
    // Admit an existing project session before holding A's creation hook.
    std::fs::write(&release, b"")?;
    let s = setup.start().await?;
    let release = HookRelease(release);
    let project = project(&s).await?;
    let session = data(
        s.gw.post("/sessions", json!({"kind":"project","project_id":project}))
            .await?,
        201,
    );
    let chat = &session["session"]["id"];
    std::fs::remove_file(&held)?;
    std::fs::remove_file(&release.0)?;
    let a = create_epic(&s, &project, "Held creation").await?;
    let b = create_epic(&s, &project, "Independent link").await?;
    {
        let first = link(&s, &a["id"]);
        tokio::pin!(first);
        let independent = async {
            while !held.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let linked = data(
                s.gw.post(
                    &format!("/canon/epics/{}/conversation", b["id"].as_str().unwrap()),
                    json!({"session_id":chat}),
                )
                .await?,
                200,
            );
            assert_eq!(linked["session_id"], *chat);
            assert_eq!(linked["work"]["sessions"][0]["session_id"], *chat);
            assert!(!release.0.exists());
            Ok::<_, HarnessError>(())
        };
        tokio::select! {
            result = &mut first => panic!("A returned while its hook was held: {result:?}"),
            result = tokio::time::timeout(Duration::from_secs(20), independent) => {
                result.map_err(|_| HarnessError("B waited for A's creation hook".into()))??;
            }
        }
        std::fs::write(&release.0, b"")?;
        let linked = first.await?;
        assert_ne!(linked["session_id"], *chat);
        assert_eq!(
            linked["work"]["sessions"][0]["session_id"],
            linked["session_id"]
        );
    }
    drop(release);
    s.finish().await
}
