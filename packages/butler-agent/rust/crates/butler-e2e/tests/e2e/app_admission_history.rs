//! Admission must publish the exact accepted Turn past the first list page.
use butler_e2e::e2e::{HarnessError, scenario::Setup};

#[tokio::test]
async fn admission_past_two_hundred_turns() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("TURN-01")?.start().await?;
    let path = s.sandbox.data.join("app-server/butler-client.sqlite");
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let db = butler_platform::sqlite::open(path)?;
        db.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<204)
          INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at)
          SELECT 'old-'||i,'general','delivered','Delivered','2000-01-01','2000-01-01' FROM n;",
        )?;
        Ok(())
    })
    .await
    .map_err(|error| HarnessError(error.to_string()))??;
    let accepted = s.gw.say("general", "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.").await?;
    let id = accepted["accepted"]["turn_id"]
        .as_str()
        .ok_or_else(|| HarnessError("accepted turn missing".into()))?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200);
    assert_eq!(view.data()["latest_turn"]["id"], id);
    s.finish().await
}
