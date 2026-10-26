use super::*;
#[tokio::test]
async fn defaults_roundtrip_restart_and_validation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("PATTERNS-SETTINGS").await?;
    // Exercise the public pure helper without adding a non-E2E test to the ratchet.
    let quiet = butler_models::models::QuietHours::new("22:00", "07:00").unwrap();
    for minute in [0, 419, 1320, 1439] {
        assert!(quiet.contains(minute));
    }
    for minute in [420, 720, 1319, 1440] {
        assert!(!quiet.contains(minute));
    }
    let day = butler_models::models::QuietHours::new("08:00", "12:00").unwrap();
    assert!(day.contains(480) && day.contains(719));
    assert!(!day.contains(479) && !day.contains(720));
    assert!(butler_models::models::QuietHours::new("08:00", "08:00").is_none());
    assert!(butler_models::models::QuietHours::new("24:00", "07:00").is_none());
    let initial = s.gw.get("/settings").await?.data().clone();
    for (key, expected) in [
        ("proactive_level", json!("sometimes")),
        ("quiet_hours_start", json!("22:00")),
        ("quiet_hours_end", json!("07:00")),
        ("chats_intro_seen", json!(false)),
    ] {
        assert_eq!(initial[key], expected);
    }
    let patch = json!({"proactive_level":"often","quiet_hours_start":"23:30","quiet_hours_end":"06:15","chats_intro_seen":true});
    let r = s.gw.patch("/settings", patch.clone()).await?;
    assert_eq!(r.status, 200, "{}", r.text);
    for (key, value) in patch.as_object().unwrap() {
        assert_eq!(r.data()[key], *value);
    }
    s.restart().await?;
    let view = s.gw.get("/settings").await?.data().clone();
    for (key, value) in patch.as_object().unwrap() {
        assert_eq!(view[key], *value);
    }
    let config: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("butler.config.json"))?)?;
    assert_eq!(config["proactive"]["level"], "often");
    assert_eq!(
        config["proactive"]["quietHours"],
        json!({"start":"23:30","end":"06:15"})
    );
    assert_eq!(config["chats"]["introSeen"], true);
    for invalid in [
        json!({"proactive_level":"always"}),
        json!({"quiet_hours_start":"24:00"}),
        json!({"quiet_hours_end":"6:15"}),
        json!({"quiet_hours_start":"06:15"}),
        json!({"quiet_hours_start":"09:00","quiet_hours_end":"09:00"}),
        json!({"chats_intro_seen":false}),
        json!({"chats_intro_seen":1}),
    ] {
        let r = s.gw.patch("/settings", invalid).await?;
        assert_eq!(r.status, 400, "{}", r.text);
    }
    assert_eq!(
        s.gw.patch(
            "/settings",
            json!({"quiet_hours_start":"08:00","quiet_hours_end":"12:00","proactive_level":"off"})
        )
        .await?
        .status,
        200
    );
    s.finish().await
}
