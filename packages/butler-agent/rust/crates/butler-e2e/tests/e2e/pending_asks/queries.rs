//! Query-plan pins against the real upgraded schema, including the unchanged read plans.
use super::*;
use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};

#[tokio::test]
async fn pending_ask_plan_pins_preserve_authority_question_and_attention_queries()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("PA-QUERY-PLANS")?.start().await?;
    s.agent.terminate().await?;
    let data = s.sandbox.data.clone();
    tokio::task::spawn_blocking(move || check(&data))
        .await
        .map_err(|e| HarnessError(e.to_string()))??;
    s.finish().await
}
fn check(data: &std::path::Path) -> Result<(), HarnessError> {
    let btcc = butler_platform::sqlite::open(data.join("agent-runtime/btcc.sqlite"))?;
    let statements = butler_turn::btcc::storage::existing_ask_plan_statements();
    btcc.execute_batch(
        "DROP INDEX idx_btcc_authority_open_v2; DROP INDEX idx_btcc_authority_pending_turn",
    )?;
    let main = statements
        .iter()
        .map(|sql| plan(&btcc, &sql.replace("(?1 IN ('session_archived','session_permanently_deleted') OR source_session_id=?3)", "source_session_id=?3")))
        .collect::<Result<Vec<_>, _>>()?;
    btcc.execute_batch(butler_turn::btcc::storage::pending_ask_projection_schema())?;
    for (sql, expected) in statements.iter().zip(main) {
        assert_eq!(
            plan(&btcc, sql)?,
            expected,
            "Existing authority/question/attention plan changed"
        );
    }
    for (sql, index) in butler_turn::btcc::storage::pending_ask_plan_statements() {
        assert_index(&btcc, &sql, index)?;
    }
    assert_index(
        &btcc,
        "SELECT request_ref FROM btcc_authority_requests INDEXED BY idx_btcc_authority_pending_turn WHERE source_turn_id=?1 AND decision='pending' AND close_reason IS NULL",
        "idx_btcc_authority_pending_turn",
    )?;
    let app = butler_platform::sqlite::open(data.join("app-server/butler-client.sqlite"))?;
    for (sql, index) in butler_gateway::gateway::storage_testing::pending_ask_plan_statements() {
        assert_index(&app, &sql, index)?;
    }
    let conversation =
        butler_platform::sqlite::open(data.join("runtime/conversation-store.sqlite"))?;
    assert_index(
        &conversation,
        butler_turn::conversation::latest_assistant_message_statement(),
        "conversation_messages_turn_role_seq_idx",
    )?;
    Ok(())
}
fn plan(db: &Connection, sql: &str) -> Result<String, HarnessError> {
    let mut statement = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
    let binds = vec![SqlValue::Null; statement.parameter_count()];
    let result = statement
        .query_map(params_from_iter(binds), |r| r.get::<_, String>(3))?
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    eprintln!("PA-PLAN {sql}\n{result}");
    Ok(result)
}
pub(super) fn assert_index(db: &Connection, sql: &str, index: &str) -> Result<(), HarnessError> {
    let result = plan(db, sql)?;
    if index.is_empty() {
        assert!(
            result.is_empty(),
            "insert unexpectedly reads a source: {sql}: {result}"
        );
    } else {
        assert!(result.contains(index), "{sql}: {result}");
    }
    for line in result.lines().filter(|line| line.starts_with("SCAN ")) {
        assert!(
            // Scalar SELECTs report a constant row, which reads no data source.
            line == "SCAN CONSTANT ROW"
                || line.contains("USING INDEX")
                || line.contains("USING COVERING INDEX")
                || line.contains("VIRTUAL TABLE"),
            "unindexed source: {sql}\n{result}"
        );
    }
    Ok(())
}
