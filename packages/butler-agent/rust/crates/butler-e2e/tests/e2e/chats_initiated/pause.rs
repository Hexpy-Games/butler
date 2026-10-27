use super::*;
async fn day(s: &Scenario, address: &str, day: u8, expected: usize) -> Result<(), HarnessError> {
    clock(address, &format!("2026-10-{day:02}T12:00:00.000Z")).await?;
    let r = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(r.status, 202, "{}", r.text);
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let reports: Vec<_> =
                s.gw.messages("general")
                    .await?
                    .into_iter()
                    .filter(|m| {
                        m["initiated"]["kind"] == "schedule_report" && m["status"] == "delivered"
                    })
                    .collect();
            if reports.len() == expected {
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("daily complete reports")
}
#[tokio::test]
async fn unopened_three_days_pause_once_and_continue_resets_count() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SS2-PAUSE", "2026-10-23T12:00:00.000Z").await?;
    create(&s, "pause-report", "general", "2026-10-24T12:00:00.000Z").await?;
    for (day_number, count) in [(24, 1), (25, 2), (26, 3)] {
        day(&s, &address, day_number, count).await?;
    }
    day(&s, &address, 27, 3).await?;
    let automation = s.gw.get("/automations/pause-report").await?;
    assert_eq!(automation.data()["automation"]["state"], "paused");
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let pauses: Vec<_> =
                s.gw.messages("general")
                    .await?
                    .into_iter()
                    .filter(|m| m["initiated"]["kind"] == "schedule_pause")
                    .collect();
            if !pauses.is_empty() {
                assert_eq!(pauses.len(), 1);
                assert_eq!(pauses[0]["initiated"]["panel"]["unopened_count"], 3);
                assert_eq!(
                    pauses[0]["initiated"]["panel"]["schedule"]["interval_seconds"],
                    86400
                );
                break Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("one pause question")?;
    assert_eq!(
        runs(&s, "pause-report").await?[0]["state"],
        "skipped_report_unopened"
    );
    let r =
        s.gw.post(
            "/automations/pause-report/report-pause",
            json!({"decision":"continue"}),
        )
        .await?;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!(r.data()["state"], "enabled");
    assert_eq!(r.data()["next_run_at"], "2026-10-28T12:00:00.000Z");
    assert_eq!(
        s.gw.post(
            "/automations/pause-report/report-pause",
            json!({"decision":"continue"})
        )
        .await?
        .status,
        409
    );
    day(&s, &address, 28, 4).await?;
    assert_eq!(
        s.gw.get("/automations/pause-report").await?.data()["automation"]["state"],
        "enabled"
    );
    day(&s, &address, 29, 5).await?;
    day(&s, &address, 30, 6).await?;
    day(&s, &address, 31, 6).await?;
    assert_eq!(
        s.gw.get("/automations/pause-report").await?.data()["automation"]["state"],
        "paused"
    );
    let stopped =
        s.gw.post(
            "/automations/pause-report/report-pause",
            json!({"decision":"stop"}),
        )
        .await?;
    assert_eq!(stopped.status, 200, "{}", stopped.text);
    assert_eq!(stopped.data()["state"], "paused");
    let events = s.gw.events_since(0).await?;
    assert!(events.iter().any(|e| e["type"] == "message.updated"
        && e["payload"]["message"]["initiated"]["panel"]["state"] == "continued"));
    s.finish().await
}
#[tokio::test]
async fn viewing_chats_breaks_the_unopened_streak() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("SS2-OPENED", "2026-10-23T12:00:00.000Z").await?;
    create(&s, "opened-report", "general", "2026-10-24T12:00:00.000Z").await?;
    day(&s, &address, 24, 1).await?;
    day(&s, &address, 25, 2).await?;
    assert_eq!(
        s.gw.post("/sessions/general/read", json!({})).await?.status,
        200
    );
    day(&s, &address, 26, 3).await?;
    day(&s, &address, 27, 4).await?;
    assert_eq!(
        s.gw.get("/automations/opened-report").await?.data()["automation"]["state"],
        "enabled"
    );
    assert!(
        !s.gw
            .messages("general")
            .await?
            .iter()
            .any(|m| m["initiated"]["kind"] == "schedule_pause")
    );
    s.finish().await
}
