use super::*;

async fn restart_at(s: &mut Scenario, now: &str) -> Result<(), HarnessError> {
    s.agent.launch.set_env("BUTLER_E2E_APP_NOW", now);
    s.restart().await
}
fn daily(time: &str) -> Value {
    json!({"schedule":{"kind":"daily","time":time,"tz":"UTC"}})
}
pub(super) async fn patch(s: &Scenario, id: &str, body: Value) -> Result<Value, HarnessError> {
    let r = s.gw.patch(&format!("/automations/{id}"), body).await?;
    assert_eq!(r.status, 200, "{}", r.text);
    Ok(r.data()["automation"].clone())
}

#[tokio::test]
async fn rule_hold_keeps_latest_across_restart_and_schedules_stay_independent()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, address) = setup("HOLD-RULE", "2026-10-27T04:29:00.000Z").await?;
    for id in ["first", "second"] {
        create(&s, id, daily("04:30")).await?;
    }
    clock(&address, "2026-10-27T04:40:00.000Z").await?;
    dispatch(&s).await?;
    for id in ["first", "second"] {
        assert_eq!(runs(&s, id).await?[0]["late"], true);
    }
    clock(&address, "2026-10-28T04:30:00.000Z").await?;
    let result = dispatch(&s).await?;
    assert!(
        result["runs"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["state"] == "queued")
    );
    for id in ["first", "second"] {
        let records = runs(&s, id).await?;
        assert_eq!(records.len(), 1, "{records:?}");
        assert_eq!(records[0]["late"], false);
        assert_eq!(records[0]["scheduled_at"], "2026-10-28T04:30:00.000Z");
        assert_eq!(
            schedule(&s, id).await?["next_run_at"],
            "2026-10-29T04:30:00.000Z"
        );
    }
    let first = runs(&s, "first").await?[0]["id"].clone();
    restart_at(&mut s, "2026-10-28T04:30:00.000Z").await?;
    dispatch(&s).await?;
    assert_eq!(runs(&s, "first").await?[0]["id"], first);
    clock(&address, "2026-10-29T04:30:00.000Z").await?;
    dispatch(&s).await?;
    clock(&address, "2026-10-29T07:00:00.000Z").await?;
    for id in ["first", "second"] {
        let records = delivered(&s, id).await?;
        assert_eq!(records.len(), 1, "{records:?}");
        assert_eq!(records[0]["scheduled_at"], "2026-10-29T04:30:00.000Z");
        assert_eq!(reports(&s, "general", id).await?.len(), 1);
        assert_eq!(
            schedule(&s, id).await?["next_run_at"],
            "2026-10-30T04:30:00.000Z"
        );
    }
    assert_eq!(runs(&s, "first").await?[0]["id"], first);
    s.finish().await
}

#[tokio::test]
async fn once_hold_survives_restart_runs_once_and_stays_paused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, address) = setup("HOLD-ONCE", "2026-10-27T04:29:00.000Z").await?;
    create(
        &s,
        "once",
        json!({"schedule_type":"once","run_at":"2026-10-27T04:30:00.000Z"}),
    )
    .await?;
    clock(&address, "2026-10-27T04:30:00.000Z").await?;
    dispatch(&s).await?;
    let queued = runs(&s, "once").await?;
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0]["state"], "queued");
    assert_eq!(schedule(&s, "once").await?["state"], "paused");
    assert!(schedule(&s, "once").await?["next_run_at"].is_null());
    restart_at(&mut s, "2026-10-27T06:30:00.000Z").await?;
    dispatch(&s).await?;
    assert_eq!(runs(&s, "once").await?, queued);
    clock(&address, "2026-10-27T07:00:00.000Z").await?;
    let records = delivered(&s, "once").await?;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["id"], queued[0]["id"]);
    assert_eq!(records[0]["scheduled_at"], "2026-10-27T04:30:00.000Z");
    assert_eq!(records[0]["late"], false);
    assert_eq!(reports(&s, "general", "once").await?.len(), 1);
    clock(&address, "2026-10-28T12:00:00.000Z").await?;
    dispatch(&s).await?;
    assert_eq!(runs(&s, "once").await?.len(), 1);
    assert_eq!(schedule(&s, "once").await?["state"], "paused");
    assert!(schedule(&s, "once").await?["next_run_at"].is_null());
    s.finish().await
}

#[tokio::test]
async fn edited_times_survive_dispatch_and_queued_runs_are_not_lost() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (name, timing, edit, expected) in [
        (
            "interval-edit",
            interval(),
            json!({"start_at":"2026-10-27T09:15:00.000Z"}),
            "2026-10-27T09:15:00.000Z",
        ),
        (
            "rule-edit",
            daily("04:30"),
            daily("09:15"),
            "2026-10-27T09:15:00.000Z",
        ),
        (
            "once-edit",
            json!({"schedule_type":"once","run_at":"2026-10-27T04:30:00.000Z"}),
            json!({"run_at":"2026-10-28T09:15:00.000Z","state":"enabled"}),
            "2026-10-28T09:15:00.000Z",
        ),
    ] {
        let (s, address) = setup(name, "2026-10-27T04:29:00.000Z").await?;
        create(&s, name, timing).await?;
        clock(&address, "2026-10-27T04:30:00.000Z").await?;
        dispatch(&s).await?;
        let queued = runs(&s, name).await?[0].clone();
        let edited = patch(&s, name, edit).await?;
        assert_eq!(edited["next_run_at"], expected);
        clock(&address, "2026-10-27T07:00:00.000Z").await?;
        let records = delivered(&s, name).await?;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["id"], queued["id"]);
        assert_eq!(records[0]["scheduled_at"], queued["scheduled_at"]);
        let after = schedule(&s, name).await?;
        assert_eq!(after["next_run_at"], edited["next_run_at"]);
        assert_eq!(after["state"], edited["state"]);
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn pause_and_delete_while_held_keep_main_delivery_semantics() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("HOLD-STATE", "2026-10-27T04:29:00.000Z").await?;
    for id in ["paused", "deleted"] {
        create(&s, id, interval()).await?;
    }
    clock(&address, "2026-10-27T04:30:00.000Z").await?;
    dispatch(&s).await?;
    let queued = runs(&s, "paused").await?[0].clone();
    patch(&s, "paused", json!({"state":"paused"})).await?;
    assert_eq!(s.gw.delete("/automations/deleted").await?.status, 200);
    clock(&address, "2026-10-27T07:00:00.000Z").await?;
    let records = delivered(&s, "paused").await?;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["id"], queued["id"]);
    assert_eq!(schedule(&s, "paused").await?["state"], "paused");
    dispatch(&s).await?;
    assert_eq!(runs(&s, "deleted").await?.len(), 1);
    assert_eq!(runs(&s, "deleted").await?[0]["state"], "queued");
    assert_eq!(reports(&s, "general", "deleted").await?, [] as [Value; 0]);
    let list = s.gw.get("/automations").await?;
    assert!(
        !list.data()["automations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"] == "deleted")
    );
    s.finish().await
}

#[tokio::test]
async fn retarget_keeps_the_original_run_target_and_future_schedule_visible()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("HOLD-TARGET", "2026-10-27T04:29:00.000Z").await?;
    let r =
        s.gw.post("/sessions", json!({"kind":"chat","title":"New target"}))
            .await?;
    assert_eq!(r.status, 201, "{}", r.text);
    let chat = r.data()["session"]["id"].as_str().unwrap().to_owned();
    create(&s, "retarget", interval()).await?;
    clock(&address, "2026-10-27T04:30:00.000Z").await?;
    dispatch(&s).await?;
    let queued = runs(&s, "retarget").await?[0].clone();
    patch(&s, "retarget", json!({"target_session_id":chat})).await?;
    clock(&address, "2026-10-27T06:30:00.000Z").await?;
    dispatch(&s).await?;
    let records = runs(&s, "retarget").await?;
    assert_eq!(
        records.len(),
        2,
        "new target absorbed by old run: {records:?}"
    );
    assert_eq!(records[1], queued);
    assert_eq!(records[0]["target_session_id"], chat);
    assert_eq!(records[0]["state"], "succeeded");
    s.gw.wait_terminal(
        &chat,
        records[0]["turn_id"].as_str().unwrap(),
        Duration::from_secs(90),
    )
    .await?;
    assert_eq!(reports(&s, &chat, "retarget").await?.len(), 1);
    assert_eq!(reports(&s, "general", "retarget").await?.len(), 0);
    clock(&address, "2026-10-27T07:00:00.000Z").await?;
    assert_eq!(delivered(&s, "retarget").await?.len(), 2);
    assert_eq!(reports(&s, "general", "retarget").await?.len(), 1);
    let held = s.provider()?.hold_next_reply("Keep new target busy.");
    let turn = s.gw.say_turn(&chat, "Keep new target busy.").await?;
    s.gw.wait_turn(
        &chat,
        &turn,
        &["thinking", "streaming"],
        Duration::from_secs(30),
    )
    .await?;
    for hour in [7, 8] {
        clock(&address, &format!("2026-10-27T{hour:02}:30:00.000Z")).await?;
        dispatch(&s).await?;
    }
    let merged = runs(&s, "retarget").await?;
    assert_eq!(merged.len(), 3, "{merged:?}");
    assert_eq!(merged.iter().filter(|r| r["state"] == "queued").count(), 1);
    assert_eq!(merged[0]["target_session_id"], chat);
    assert_eq!(merged[0]["scheduled_at"], "2026-10-27T08:30:00.000Z");
    assert_eq!(merged[2]["id"], queued["id"]);
    assert_eq!(merged[2]["scheduled_at"], queued["scheduled_at"]);
    held.release();
    assert_eq!(delivered(&s, "retarget").await?.len(), 3);
    assert_eq!(reports(&s, &chat, "retarget").await?.len(), 2);
    assert_eq!(reports(&s, "general", "retarget").await?.len(), 1);
    s.finish().await
}

#[tokio::test]
async fn held_queue_has_no_idle_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("HOLD-IDLE", "2026-10-27T04:29:00.000Z").await?;
    create(&s, "idle", interval()).await?;
    clock(&address, "2026-10-27T04:30:00.000Z").await?;
    dispatch(&s).await?;
    clock(&address, "2026-10-27T05:30:00.000Z").await?;
    dispatch(&s).await?;
    let before = runs(&s, "idle").await?;
    assert_eq!(before.len(), 1);
    assert_eq!(before[0]["state"], "queued");
    assert_eq!(before[0]["scheduled_at"], "2026-10-27T05:30:00.000Z");
    crate::memory_fixture::settle(&s.sandbox.data).await?;
    let mut watch = crate::idle_resources::writes::Watch::open_after_quiet_with_paths(
        &s.sandbox.data,
        &[&s.sandbox.logs],
    )
    .await?;
    tokio::time::sleep(Duration::from_secs(60)).await;
    watch.assert_unchanged();
    drop(watch);
    assert_eq!(runs(&s, "idle").await?, before);
    assert_eq!(s.gw.messages("general").await?, [] as [Value; 0]);
    eprintln!("HOLD-IDLE idle_seconds=60 data_and_log_writes=0 queued_runs=1 replies=0");
    s.finish().await
}
