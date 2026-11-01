use super::*;

#[tokio::test]
async fn lift_round_merges_current_occurrence_and_sends_earlier_other_schedule()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for with_other in [false, true] {
        let (s, address) = setup("HOLD-LIFT", "2026-10-27T04:29:00.000Z").await?;
        if with_other {
            create(
                &s,
                "earlier",
                json!({"schedule_type":"once","run_at":"2026-10-27T04:30:00.000Z"}),
            )
            .await?;
        }
        create(&s, "hourly", json!({"schedule_type":"interval","interval_seconds":3600,"start_at":"2026-10-27T05:00:00.000Z"})).await?;
        clock(&address, "2026-10-27T04:30:00.000Z").await?;
        dispatch(&s).await?;
        for hour in [5, 6] {
            clock(&address, &format!("2026-10-27T{hour:02}:00:00.000Z")).await?;
            dispatch(&s).await?;
        }
        let queued = runs(&s, "hourly").await?;
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0]["scheduled_at"], "2026-10-27T06:00:00.000Z");
        clock(&address, "2026-10-27T07:00:00.000Z").await?;
        dispatch(&s).await?;
        let current = runs(&s, "hourly").await?;
        assert_eq!(current.len(), 1, "lift created another run: {current:?}");
        assert_eq!(current[0]["scheduled_at"], "2026-10-27T07:00:00.000Z");
        assert_eq!(current[0]["id"], queued[0]["id"]);
        let ids = if with_other {
            vec!["earlier", "hourly"]
        } else {
            vec!["hourly"]
        };
        for id in ids {
            assert_eq!(delivered(&s, id).await?.len(), 1);
            assert_eq!(reports(&s, "general", id).await?.len(), 1);
        }
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn wake_past_occurrences_merges_latest_before_dispatch() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("HOLD-WAKE", "2026-10-27T04:29:00.000Z").await?;
    create(&s, "wake", interval()).await?;
    clock(&address, "2026-10-27T04:30:00.000Z").await?;
    dispatch(&s).await?;
    let queued = runs(&s, "wake").await?;
    assert_eq!(queued.len(), 1);
    clock(&address, "2026-10-27T09:42:00.000Z").await?;
    clock(&address, "wake").await?;
    let records = delivered(&s, "wake").await?;
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["id"], queued[0]["id"]);
    assert_eq!(records[0]["scheduled_at"], "2026-10-27T09:30:00.000Z");
    assert_eq!(reports(&s, "general", "wake").await?.len(), 1);
    assert_eq!(
        schedule(&s, "wake").await?["next_run_at"],
        "2026-10-27T10:30:00.000Z"
    );
    s.finish().await
}
