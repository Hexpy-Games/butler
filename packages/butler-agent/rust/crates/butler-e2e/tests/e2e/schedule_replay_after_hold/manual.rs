use super::*;

#[tokio::test]
async fn queued_manual_and_scheduled_runs_stay_separate_for_once_and_interval()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for kind in ["once", "interval"] {
        let (s, address) = setup("HOLD-MANUAL", "2026-10-27T04:29:00.000Z").await?;
        let held = s.provider()?.hold_next_reply("Wait for the report.");
        let first = s.gw.say_turn("general", "Wait for the report.").await?;
        s.gw.wait_turn(
            "general",
            &first,
            &["thinking", "streaming"],
            Duration::from_secs(30),
        )
        .await?;
        let timing = if kind == "once" {
            json!({"schedule_type":"once","run_at":"2026-10-27T04:30:00.000Z"})
        } else {
            interval()
        };
        create(&s, "mixed", timing).await?;
        // Recurring: a queued manual run must not hide the first due occurrence.
        // Once: main pauses on enqueue; queue the occurrence before run-now.
        if kind == "once" {
            clock(&address, "2026-10-27T04:30:00.000Z").await?;
            dispatch(&s).await?;
        }
        let manual = s.gw.post("/automations/mixed/run", json!({})).await?;
        assert_eq!(manual.status, 202, "{}", manual.text);
        assert_eq!(manual.data()["run"]["state"], "queued");
        assert_eq!(manual.data()["run"]["trigger"], "manual");
        assert!(manual.data()["run"]["scheduled_at"].is_null());
        if kind == "interval" {
            for hour in [4, 5, 6] {
                clock(&address, &format!("2026-10-27T{hour:02}:30:00.000Z")).await?;
                dispatch(&s).await?;
            }
        }
        let queued = runs(&s, "mixed").await?;
        assert_eq!(queued.len(), 2, "{queued:?}");
        assert_eq!(
            queued
                .iter()
                .filter(|r| r["trigger"] == "scheduled")
                .count(),
            1
        );
        assert!(queued.iter().all(|r| r["state"] == "queued"));
        clock(&address, "2026-10-27T07:00:00.000Z").await?;
        held.release();
        let records = delivered(&s, "mixed").await?;
        assert_eq!(records.len(), 2);
        assert_eq!(reports(&s, "general", "mixed").await?.len(), 2);
        let manual_run = records.iter().find(|r| r["trigger"] == "manual").unwrap();
        assert_eq!(manual_run["id"], manual.data()["run"]["id"]);
        assert!(manual_run["scheduled_at"].is_null());
        let scheduled = records
            .iter()
            .find(|r| r["trigger"] == "scheduled")
            .unwrap();
        assert_eq!(
            scheduled["scheduled_at"],
            if kind == "once" {
                "2026-10-27T04:30:00.000Z"
            } else {
                "2026-10-27T06:30:00.000Z"
            }
        );
        assert_eq!(
            schedule(&s, "mixed").await?["state"],
            if kind == "once" { "paused" } else { "enabled" }
        );
        s.finish().await?;
    }
    Ok(())
}
