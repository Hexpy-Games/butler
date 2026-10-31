use super::{lifecycle::patch, *};

#[tokio::test]
async fn edited_time_merges_before_lift_and_preserves_new_timing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (name, timing, edit) in [
        (
            "interval-merge",
            interval(),
            json!({"start_at":"2026-10-27T05:15:00.000Z"}),
        ),
        (
            "rule-merge",
            json!({"schedule":{"kind":"daily","time":"04:30","tz":"UTC"}}),
            json!({"schedule":{"kind":"daily","time":"05:15","tz":"UTC"}}),
        ),
    ] {
        let (s, address) = setup(name, "2026-10-27T04:29:00.000Z").await?;
        create(&s, name, timing).await?;
        clock(&address, "2026-10-27T04:30:00.000Z").await?;
        dispatch(&s).await?;
        let original = runs(&s, name).await?[0].clone();
        let edited = patch(&s, name, edit).await?;
        assert_eq!(edited["next_run_at"], "2026-10-27T05:15:00.000Z");
        clock(&address, "2026-10-27T05:15:00.000Z").await?;
        dispatch(&s).await?;
        let merged = runs(&s, name).await?;
        assert_eq!(merged.len(), 1, "{merged:?}");
        assert_eq!(merged[0]["id"], original["id"]);
        assert_eq!(merged[0]["state"], "queued");
        assert_eq!(merged[0]["scheduled_at"], "2026-10-27T05:15:00.000Z");
        let before_lift = schedule(&s, name).await?;
        let r =
            s.gw.patch("/settings", json!({"quiet_hours_end":"05:16"}))
                .await?;
        assert_eq!(r.status, 200, "{}", r.text);
        clock(&address, "2026-10-27T05:16:00.000Z").await?;
        let records = delivered(&s, name).await?;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["scheduled_at"], merged[0]["scheduled_at"]);
        assert_eq!(reports(&s, "general", name).await?.len(), 1);
        let after = schedule(&s, name).await?;
        assert_eq!(after["next_run_at"], before_lift["next_run_at"]);
        assert_eq!(after["schedule"], before_lift["schedule"]);
        assert_eq!(after["start_at"], before_lift["start_at"]);
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn once_reenabled_edit_merges_then_pauses() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("HOLD-ONCE-MERGE", "2026-10-27T04:29:00.000Z").await?;
    create(
        &s,
        "once",
        json!({"schedule_type":"once","run_at":"2026-10-27T04:30:00.000Z"}),
    )
    .await?;
    clock(&address, "2026-10-27T04:30:00.000Z").await?;
    dispatch(&s).await?;
    let original = runs(&s, "once").await?[0].clone();
    let edit = patch(
        &s,
        "once",
        json!({"state":"enabled","run_at":"2026-10-27T05:15:00.000Z"}),
    )
    .await?;
    assert_eq!(edit["state"], "enabled");
    assert_eq!(edit["next_run_at"], "2026-10-27T05:15:00.000Z");
    clock(&address, "2026-10-27T05:15:00.000Z").await?;
    dispatch(&s).await?;
    let merged = runs(&s, "once").await?;
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0]["id"], original["id"]);
    assert_eq!(merged[0]["state"], "queued");
    assert_eq!(merged[0]["scheduled_at"], "2026-10-27T05:15:00.000Z");
    assert_eq!(schedule(&s, "once").await?["state"], "paused");
    clock(&address, "2026-10-27T07:00:00.000Z").await?;
    assert_eq!(delivered(&s, "once").await?.len(), 1);
    assert_eq!(reports(&s, "general", "once").await?.len(), 1);
    let after = schedule(&s, "once").await?;
    assert_eq!(after["run_at"], "2026-10-27T05:15:00.000Z");
    assert_eq!(after["state"], "paused");
    assert!(after["next_run_at"].is_null());
    s.finish().await
}

#[tokio::test]
async fn hold_lifts_just_before_occurrence_with_queued_run_in_next_round()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("HOLD-MOMENT", "2026-10-27T04:29:00.000Z").await?;
    create(&s, "moment", json!({"schedule_type":"interval","interval_seconds":3600,"start_at":"2026-10-27T05:00:00.001Z"})).await?;
    for hour in [5, 6] {
        clock(&address, &format!("2026-10-27T{hour:02}:00:00.001Z")).await?;
        dispatch(&s).await?;
    }
    let merged = runs(&s, "moment").await?;
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0]["scheduled_at"], "2026-10-27T06:00:00.001Z");
    clock(&address, "2026-10-27T07:00:00.000Z").await?;
    assert_eq!(runs(&s, "moment").await?[0]["state"], "queued");
    clock(&address, "2026-10-27T07:00:00.001Z").await?;
    dispatch(&s).await?;
    let current = runs(&s, "moment").await?;
    assert_eq!(current.len(), 1, "{current:?}");
    assert_eq!(current[0]["scheduled_at"], "2026-10-27T07:00:00.001Z");
    assert_eq!(delivered(&s, "moment").await?.len(), 1);
    assert_eq!(reports(&s, "general", "moment").await?.len(), 1);
    s.finish().await
}

#[tokio::test]
async fn unopened_pause_merges_existing_queue_and_skips_without_second_row()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("HOLD-UNOPENED", "2026-10-23T11:59:00.000Z").await?;
    create(&s, "unopened", json!({"schedule_type":"interval","interval_seconds":3600,"start_at":"2026-10-23T12:00:00.000Z"})).await?;
    for day in [23, 24, 25] {
        clock(&address, &format!("2026-10-{day:02}T12:00:00.000Z")).await?;
        dispatch(&s).await?;
        delivered(&s, "unopened").await?;
    }
    assert_eq!(reports(&s, "general", "unopened").await?.len(), 3);
    for hour in [4, 5] {
        clock(&address, &format!("2026-10-26T{hour:02}:00:00.000Z")).await?;
        dispatch(&s).await?;
        let records = runs(&s, "unopened").await?;
        assert_eq!(records.len(), 4);
        assert_eq!(records.iter().filter(|r| r["state"] == "queued").count(), 1);
        assert_eq!(
            records[0]["scheduled_at"],
            format!("2026-10-26T{hour:02}:00:00.000Z")
        );
    }
    let queued = runs(&s, "unopened").await?[0].clone();
    clock(&address, "2026-10-26T07:00:00.000Z").await?;
    dispatch(&s).await?;
    let records = runs(&s, "unopened").await?;
    assert_eq!(records.len(), 4);
    assert_eq!(records[0]["id"], queued["id"]);
    assert_eq!(records[0]["state"], "skipped_report_unopened");
    let after = schedule(&s, "unopened").await?;
    assert_eq!(after["state"], "paused");
    assert_eq!(after["last_run_state"], "skipped_report_unopened");
    assert_eq!(after["next_run_at"], "2026-10-26T06:00:00.000Z");
    let messages = reports(&s, "general", "unopened").await?;
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["initiated"]["kind"] == "schedule_report")
            .count(),
        3
    );
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["initiated"]["kind"] == "schedule_pause")
            .count(),
        1
    );
    dispatch(&s).await?;
    assert_eq!(runs(&s, "unopened").await?, records);
    s.finish().await
}
