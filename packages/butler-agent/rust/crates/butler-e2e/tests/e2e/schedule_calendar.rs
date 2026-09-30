//! Calendar schedules through the real gateway, persisted store and scheduler.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::json;

#[tokio::test]
async fn daily_calendar_survives_restart_and_dst_boundary() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (now, expected, id) in [
        (
            "2026-03-07T14:00:00.000Z",
            "2026-03-08T12:00:00.000Z",
            "0-daily-eight",
        ),
        (
            "2026-03-08T11:00:00.000Z",
            "2026-03-08T12:00:00.000Z",
            "z-daily-eight",
        ),
        (
            "2026-10-31T13:00:00.000Z",
            "2026-11-01T13:00:00.000Z",
            "daily-eight",
        ),
    ] {
        let mut s = Setup::new("SCHED-07")?
            .env("BUTLER_E2E_APP_NOW", now)
            .env("BUTLER_E2E_TIER", "stub")
            .start()
            .await?;
        let rule = json!({"kind":"daily","time":"08:00","tz":"America/New_York","weekdays":[]});
        let created =
            s.gw.post(
                "/automations",
                json!({"id":id,"title":"Café",
            "prompt_body":"Brief me","target_session_id":"general","schedule":rule}),
            )
            .await?;
        assert_eq!(created.status, 201, "{}", created.text);
        assert_eq!(created.data()["automation"]["next_run_at"], expected);
        assert_eq!(created.data()["automation"]["schedule"], rule);
        let space = s.gw.get("/navigation").await?;
        let group =
            s.gw.post(
                "/space/groups",
                json!({"expectedRevision":space.data()["space"]["revision"],
            "title":"Café","parentKey":null}),
            )
            .await?;
        assert_eq!(group.status, 200, "{}", group.text);
        let palette = s.gw.get("/command-palette?query=caf%C3%A9").await?;
        assert_eq!(palette.status, 200);
        // Equal title matches with no recency sort by ID, not entity kind.
        // IDs on either side of every UUID exercise both possible orders.
        let group_id = group.data()["groupId"].as_str().unwrap();
        let mut expected_results = vec![(id, "automation", "Café"), (group_id, "group", "Café")];
        expected_results.sort_by_key(|item| item.0);
        let results = palette.data()["results"].as_array().unwrap();
        let actual_results = results
            .iter()
            .map(|item| {
                (
                    item["id"].as_str().unwrap(),
                    item["kind"].as_str().unwrap(),
                    item["title"].as_str().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(actual_results, expected_results);
        s.restart().await?;
        let listed = s.gw.get("/automations").await?;
        assert_eq!(listed.status, 200);
        let rows = listed.data()["automations"].as_array().unwrap().clone();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["schedule"], rule);
        assert_eq!(rows[0]["next_run_at"], expected);
        assert!(rows[0].get("interval_label").is_none());
        let patched =
            s.gw.patch(
                &format!("/automations/{id}"),
                json!({"schedule":{
            "kind":"weekly","time":"08:00","tz":"America/New_York","weekdays":[1,2,3,4,5]}}),
            )
            .await?;
        assert_eq!(patched.status, 200, "{}", patched.text);
        assert_eq!(
            patched.data()["automation"]["schedule"]["weekdays"],
            json!([1, 2, 3, 4, 5])
        );
        let monday = if now.starts_with("2026-10") {
            "2026-11-02T13:00:00.000Z"
        } else {
            "2026-03-09T12:00:00.000Z"
        };
        assert_eq!(patched.data()["automation"]["next_run_at"], monday);
        let invalid =
            s.gw.patch(
                &format!("/automations/{id}"),
                json!({"schedule":{
            "kind":"daily","time":"08:00","tz":"../etc/passwd"}}),
            )
            .await?;
        assert_eq!(invalid.status, 400);
        let interval =
            s.gw.patch(
                &format!("/automations/{id}"),
                json!({"schedule_type":"interval","interval_seconds":3600}),
            )
            .await?;
        assert_eq!(interval.status, 200, "{}", interval.text);
        assert!(interval.data()["automation"]["schedule"].is_null());
        let expected_interval =
            chrono::DateTime::parse_from_rfc3339(now).unwrap() + chrono::Duration::hours(1);
        assert_eq!(
            interval.data()["automation"]["next_run_at"],
            expected_interval.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
        s.finish().await?;
    }
    Ok(())
}
