use super::*;

#[tokio::test]
async fn epic_delete_refuses_started_unlinked_moved_and_live_bound_turns()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("EPIC-DELETE-GUARDS", Access::AskAlways).await?;
    for kind in ["started", "moved", "bound"] {
        let epic = create(&s, &project).await?;
        let id = epic["id"].as_str().unwrap();
        let proposal = draft(&s, &script, &chat, args(&project, &epic)).await?;
        let home = data(
            s.gw.post(&format!("/canon/epics/{id}/conversation"), json!({}))
                .await?,
            200,
        )["session_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let canon = db(&s)?;
        let owner: String = canon.query_row(
            "SELECT session_id FROM canon_session_epics WHERE epic_id=?1",
            [id],
            |r| r.get(0),
        )?;
        let turn = if kind == "moved" {
            canon.execute(
                "INSERT INTO canon_step_cancellations VALUES('pending-move',?1,?2)",
                rusqlite::params![id, owner],
            )?;
            canon.execute_batch("CREATE TRIGGER hold_cancellation BEFORE DELETE ON canon_step_cancellations BEGIN SELECT RAISE(ABORT,'source unavailable'); END;")?;
            None
        } else {
            script
                .hold_next
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let turn = if kind == "started" {
                data(
                    s.gw.post(
                        &format!("/sessions/{home}/canon/queue"),
                        json!({"op":"start_now","epic_id":id}),
                    )
                    .await?,
                    200,
                );
                None
            } else {
                Some(s.gw.say(&home, "Wait at the first model round").await?)
            };
            tokio::time::timeout(Duration::from_secs(15), script.held.notified())
                .await
                .map_err(|e| HarnessError(e.to_string()))?;
            Some(match turn {
                Some(reply) => s.gw.accepted_turn(&reply).await?,
                None => s.gw.turns(&home).await?[0]["id"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            })
        };
        assert_eq!(count(&canon, "canon_epic_work_links", id), 0);
        let refusal = delete(&s, &epic, &epic["revision"]).await?;
        assert_eq!(refusal.status, 409, "{kind}: {}", refusal.text);
        assert_eq!(refusal.body["error"]["code"], "running");
        assert_eq!(
            data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200)["delete_blocked"],
            true
        );
        let refused =
            s.gw.post(
                &format!("/canon/proposals/{proposal}"),
                json!({"outcome":"accepted"}),
            )
            .await?;
        assert_eq!(refused.status, 409, "{kind}: {}", refused.text);
        assert_eq!(refused.body["error"]["code"], "running");
        if let Some(turn) = turn {
            script.release.notify_one();
            s.gw.wait_terminal(&home, &turn, Duration::from_secs(60))
                .await?;
        }
        // A finished turn needs no artificial hold to become deletable.
        if kind == "moved" {
            canon.execute_batch("DROP TRIGGER hold_cancellation")?;
        }
        canon.execute(
            "DELETE FROM canon_step_cancellations WHERE epic_id=?1",
            [id],
        )?;
        assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    }
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_resolve_ask_requires_card_even_with_matching_negative_quote()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("EPIC-DELETE-CARD", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = draft(&s, &script, &chat, args(&project, &epic)).await?;
    run(
        &s,
        &script,
        &chat,
        "삭제하지 마",
        vec![(
            "resolve_ask",
            json!({"ask_id":format!("canon:{id}"),"outcome":"accepted","quote":"삭제"}),
        )],
    )
    .await?;
    assert_eq!(read(&s, &id).await?["state"], "open");
    assert!(
        stub::results(&script)
            .iter()
            .any(|r| r["error"]["code"] == "approval_card_only")
    );
    assert_eq!(accept(&s, &id).await?["ok"], true);
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_proposal_refuses_another_project() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("EPIC-DELETE-SCOPE", Access::AskAlways).await?;
    let other = data(
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Other"}),
        )
        .await?,
        201,
    );
    let epic = create(&s, other["project"]["id"].as_str().unwrap()).await?;
    run(
        &s,
        &script,
        &chat,
        "Wrong project",
        vec![("canon_propose", args(&project, &epic))],
    )
    .await?;
    assert_eq!(asks(&s, &chat).await?["open_count"], 0);
    assert!(
        stub::results(&script)
            .iter()
            .any(|r| r["error"]["code"] == "work_model_invalid"
                && r["error"]["message"]
                    .as_str()
                    .is_some_and(|s| s.contains("operation outside project"))),
        "{:?}",
        stub::results(&script)
    );
    assert_eq!(
        s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
            .await?
            .status,
        200
    );
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn epic_delete_missing_target_settles_the_ask_without_future_reminders()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, project, chat) =
        setup("EPIC-DELETE-ASK-MISSING", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = draft(&s, &script, &chat, json!({"project_id":project,"summary":"Change Epic","changes":[{"op":"epic.edit","id":epic["id"],"expected_revision":epic["revision"],"title":"New title"}]})).await?;
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    let start = script.requests.lock().unwrap().len();
    run(
        &s,
        &script,
        &chat,
        "응 변경해",
        vec![(
            "resolve_ask",
            json!({"ask_id":format!("canon:{id}"),"outcome":"accepted","quote":"응 변경해"}),
        )],
    )
    .await?;
    assert!(
        stub::results(&script)
            .iter()
            .any(|r| r["error"]["code"] == "canon_not_found")
    );
    assert_eq!(read(&s, &id).await?["state"], "stale");
    assert_eq!(asks(&s, &chat).await?["open_count"], 0);
    {
        let requests = script.requests.lock().unwrap();
        assert!(
            requests[start]["input"][0]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("## Open asks")
        );
    }
    assert!(
        script.requests.lock().unwrap()[start + 1..]
            .iter()
            .any(|request| {
                request["input"].as_array().unwrap().iter().any(|item| {
                    item["output"]
                        .as_str()
                        .is_some_and(|output| output.contains("canon_not_found"))
                })
            }),
        "the same turn receives the terminal refusal"
    );
    script.requests.lock().unwrap().clear();
    s.turn(&chat, "다음 요청").await?;
    assert!(script.requests.lock().unwrap().iter().all(|request| {
        !request["input"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("## Open asks")
    }));
    server.abort();
    s.finish().await
}
