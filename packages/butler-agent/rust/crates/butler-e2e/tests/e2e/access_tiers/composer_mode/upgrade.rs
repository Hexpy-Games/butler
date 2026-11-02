//! Upgrade the prior column layout without changing its activated manifest.
use super::*;

#[tokio::test]
async fn prior_storage_keeps_the_pending_answer_and_composer_change() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server) = setup().await?;
    let turn = paused(&s, "general", PROMPT).await?;
    let cards = s.gw.approval_requests("general").await?;
    controls(&s, "full_access").await?;
    s.agent.terminate().await?;
    {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        db.execute_batch(
            "DROP INDEX idx_btcc_authority_composer_revision;
            ALTER TABLE btcc_authority_requests DROP COLUMN reusable;
            ALTER TABLE btcc_authority_requests DROP COLUMN execution_access_mode;
            ALTER TABLE btcc_authority_requests DROP COLUMN composer_access_mode;
            ALTER TABLE btcc_authority_requests DROP COLUMN composer_root_turn_id;
            ALTER TABLE btcc_authority_requests DROP COLUMN composer_revision;
            ALTER TABLE btcc_subsession_delegations DROP COLUMN access_limit_mode;
            ALTER TABLE btcc_subsession_delegations DROP COLUMN access_limit_recorded;",
        )?;
    }
    s.gw = s.agent.start_again().await?;
    answer(&s, cards[0]["request_ref"].as_str().unwrap(), "allow").await?;
    delivered(&s, "general", &turn).await?;
    assert_revision(&s, &turn, "full_access", 1)?;
    assert_counts(&s, &turn, 1, 0)?;
    assert_eq!(s.gw.approval_requests("general").await?, [] as [Value; 0]);
    s.finish().await?;
    server.abort();
    Ok(())
}
