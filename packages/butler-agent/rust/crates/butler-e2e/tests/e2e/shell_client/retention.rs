//! Resume over the same finished-turn progress deletion used by retention.
use super::*;
use butler_platform::sqlite;

#[tokio::test]
async fn finished_progress_holes_preserve_every_retained_event() -> Result<(), TestError> {
    butler_e2e::gate!();
    let mut s = start("SHELL-HOLE", 1, Access::FullAccess).await?;
    let (turn, _) = s.turn("general", "Read approval.txt").await?;
    s.agent.terminate().await?;
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let first: u64 = db.query_row(
        "SELECT MIN(source_event_id) FROM app_terminal_turn_progress_rows WHERE turn_id=?1",
        [&turn],
        |row| row.get(0),
    )?;
    let cursor = first - 1;
    let removed = db.execute(
        "DELETE FROM events WHERE id IN (SELECT source_event_id FROM app_terminal_turn_progress_rows WHERE turn_id=?1)",
        [&turn])?;
    assert!(removed > 0);
    let expected = db
        .prepare("SELECT id FROM events WHERE id>?1 ORDER BY id")?
        .query_map([cursor], |row| row.get::<_, u64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    assert_ne!(expected, [] as [u64; 0]);
    assert!(expected[0] > cursor + 1);
    drop(db);
    s.restart().await?;
    let client = attach(&s).await?;
    // Retrying the identical cursor must also progress rather than repeat a gap error.
    for _ in 0..2 {
        let mut stream = client.live_events(cursor);
        let mut actual = Vec::new();
        tokio::time::timeout(Duration::from_secs(15), async {
            while actual.len() < expected.len() {
                if let Some(id) = stream.next().await.unwrap().unwrap().cursor {
                    actual.push(id);
                }
            }
        })
        .await?;
        assert_eq!(actual, expected);
    }
    s.finish().await?;
    Ok(())
}
