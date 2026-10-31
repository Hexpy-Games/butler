use super::*;

pub(super) fn reference(
    data: &Path,
    id: &str,
    turn: &str,
    session: &str,
) -> Result<(), HarnessError> {
    let actual: String = db(data)?.query_row(
        "SELECT session FROM output_refs WHERE id=?1 AND turn=?2",
        params![id, turn],
        |r| r.get(0),
    )?;
    assert_eq!(
        actual, session,
        "source transcript reference left the archive"
    );
    let cards = OutputStore::new(data).message_summaries(session, &[turn.to_owned()])?;
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].output_id, id);
    assert_eq!(cards[0].turn_id, turn);
    Ok(())
}

async fn card(s: &Scenario, session: &str, turn: &str, id: &str) -> Result<(), HarnessError> {
    let reply = s.gw.get(&format!("/messages?chat_id={session}")).await?;
    assert_eq!(reply.status, 200, "{reply:?}");
    let data = reply.data();
    let messages = data["messages"].as_array().unwrap();
    assert!(
        messages.iter().any(|m| {
            m["turn_id"] == turn
                && m["artifacts"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|a| a["id"] == id))
        }),
        "archive transcript lost the card: {reply:?}"
    );
    Ok(())
}

async fn published(s: &mut Scenario) -> Result<(String, String), HarnessError> {
    let (turn, result) = s.turn("general", "Publish").await?;
    assert_eq!(result["state"], "delivered", "{result}");
    let outputs = OutputStore::new(&s.sandbox.data).summaries("general")?;
    assert_eq!(outputs.len(), 1);
    Ok((outputs[0].output_id.clone(), turn))
}

#[tokio::test]
async fn normal_adopt_archive_keeps_child_turn_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("OWNER-NORMAL-ARCHIVE-REF")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let parent = chat(&s).await?;
    let (id, turn) = published(&mut s).await?;
    s.agent.terminate().await?;
    OutputStore::new(&s.sandbox.data).adopt(&id, &parent, "parent-turn", "parent-message")?;
    assert!(!markers(&s.sandbox.data, "general").join(&id).exists());
    s.gw = s.agent.start_again().await?;
    let archived = archive(&s).await?;
    reference(&s.sandbox.data, &id, &turn, &archived)?;
    live_rows(&s.sandbox.data, &id, &parent)?;
    no_session_rows(&s.sandbox.data, "general")?;
    card(&s, &archived, &turn, &id).await?;
    s.finish().await
}

#[tokio::test]
async fn archive_manifest_crash_replays_transfer_and_keeps_cards() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("OWNER-ARCHIVE-REPLAY-REF")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let parent = chat(&s).await?;
    let (own, turn) = published(&mut s).await?;
    s.agent.terminate().await?;
    let adopted = seed(&s.sandbox.data, "general", "earlier", b"Adopted", true)?;
    OutputStore::new(&s.sandbox.data).adopt(&adopted, &parent, "parent-turn", "parent-message")?;
    db(&s.sandbox.data)?.execute_batch(&format!(
        "CREATE TRIGGER stop_archive BEFORE INSERT ON outputs WHEN NEW.id='{own}' AND NEW.session<>'general' BEGIN SELECT RAISE(ABORT,'archive index interrupted'); END;"
    ))?;
    s.gw = s.agent.start_again().await?;
    let reply =
        s.gw.post("/sessions/general/clear", json!({"title":"Saved"}))
            .await?;
    assert_eq!(reply.status, 500, "{reply:?}");
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let archived: String =
        app.query_row("SELECT archive_id FROM app_output_transfers", [], |r| {
            r.get(0)
        })?;
    assert_eq!(owner(&s.sandbox.data, &own)?, archived);
    reference(&s.sandbox.data, &own, &turn, "general")?;
    s.agent.terminate().await?;
    db(&s.sandbox.data)?.execute_batch("DROP TRIGGER stop_archive")?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        app.query_row("SELECT count(*) FROM app_output_transfers", [], |r| r
            .get::<_, i64>(0))?,
        0
    );
    assert_eq!(
        app.query_row(
            "SELECT count(*) FROM app_session_context_gate WHERE session_id='general'",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        0
    );
    reference(&s.sandbox.data, &own, &turn, &archived)?;
    reference(&s.sandbox.data, &adopted, "earlier", &archived)?;
    live_rows(&s.sandbox.data, &own, &archived)?;
    live_rows(&s.sandbox.data, &adopted, &parent)?;
    no_session_rows(&s.sandbox.data, "general")?;
    card(&s, &archived, &turn, &own).await?;
    content(&s, &adopted, "Adopted").await?;
    s.finish().await
}

#[tokio::test]
async fn archive_crash_partway_through_three_manifests_replays_all() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("OWNER-PARTIAL-ARCHIVE")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    s.agent.terminate().await?;
    let data = &s.sandbox.data;
    let mut outputs = Vec::new();
    for (slot, body) in [("one", "First"), ("two", "Second"), ("three", "Third")] {
        outputs.push((
            seed(data, "general", slot, body.as_bytes(), true)?,
            slot,
            body,
        ));
    }
    outputs.sort();
    db(data)?.execute_batch(&format!(
        "CREATE TRIGGER stop_archive BEFORE INSERT ON outputs WHEN NEW.id='{}' AND NEW.session<>'general' BEGIN SELECT RAISE(ABORT,'archive index interrupted'); END;", outputs[0].0
    ))?;
    s.gw = s.agent.start_again().await?;
    let reply =
        s.gw.post("/sessions/general/clear", json!({"title":"Saved"}))
            .await?;
    assert_eq!(reply.status, 500, "{reply:?}");
    s.agent.kill9()?;
    let app = butler_platform::sqlite::open(data.join("app-server/butler-client.sqlite"))?;
    let archived: String =
        app.query_row("SELECT archive_id FROM app_output_transfers", [], |r| {
            r.get(0)
        })?;
    for (i, (id, turn, _)) in outputs.iter().enumerate() {
        assert_eq!(owner(data, id)?, if i == 0 { &archived } else { "general" });
        assert!(markers(data, "general").join(id).is_file());
        assert_eq!(markers(data, &archived).join(id).is_file(), i == 0);
        reference(data, id, turn, "general")?;
    }
    assert_eq!(OutputStore::new(data).summaries("general")?.len(), 3);
    db(data)?.execute_batch("DROP TRIGGER stop_archive")?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        app.query_row("SELECT count(*) FROM app_output_transfers", [], |r| r
            .get::<_, i64>(0))?,
        0
    );
    let summaries = OutputStore::new(data).summaries(&archived)?;
    assert_eq!(summaries.len(), 3);
    assert_eq!(
        summaries.iter().map(|r| &r.output_id).collect::<Vec<_>>(),
        outputs.iter().map(|r| &r.0).collect::<Vec<_>>()
    );
    assert_eq!(scalar(data, "SELECT count(*) FROM outputs")?, 3);
    assert_eq!(scalar(data, "SELECT count(*) FROM output_refs")?, 3);
    assert_eq!(scalar(data, "SELECT count(*) FROM output_blobs")?, 3);
    for (id, turn, body) in outputs {
        live_rows(data, &id, &archived)?;
        reference(data, &id, turn, &archived)?;
        content(&s, &id, body).await?;
    }
    no_session_rows(data, "general")?;
    s.finish().await
}
