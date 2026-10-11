//! Opt-in developer capture observes each setting change on the running agent.
use super::*;

#[tokio::test]
async fn diagnostics_reader_tracks_latest_settings() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("DEVELOPER-SETTINGS")?
        .cassette("Q-02")
        .start()
        .await?;
    let path = s.sandbox.data.join("app/developer-logs/model-turns.jsonl");
    let mut captured = Vec::new();
    for enabled in [false, true, false, true, false] {
        let reply =
            s.gw.patch("/settings", json!({"diagnostics_enabled": enabled}))
                .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        assert_eq!(reply.data()["diagnostics_enabled"], enabled);
        let (id, turn) = s
            .turn("general", "Reply with exactly the word: waiting")
            .await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
        if enabled {
            captured.push(id);
        }
        let path = path.clone();
        let text = tokio::task::spawn_blocking(move || match std::fs::read_to_string(path) {
            Ok(text) => Ok(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(HarnessError(error.to_string())),
        })
        .await
        .map_err(|error| HarnessError(error.to_string()))??;
        let rows = text
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            rows.len(),
            captured.len(),
            "only currently enabled turns are captured"
        );
        for (row, id) in rows.iter().zip(&captured) {
            assert_eq!(row["turn_id"], *id);
            assert_eq!(row["schema"], "butler.developer-log.v1");
            assert_eq!(row["request"]["metadata"]["request_available"], true);
            assert_eq!(row["request"]["metadata"]["provider_round_count"], 1);
            assert_eq!(row["response"]["text"], "waiting");
            assert!(row["response"]["raw"].is_object());
        }
    }
    s.finish().await
}
