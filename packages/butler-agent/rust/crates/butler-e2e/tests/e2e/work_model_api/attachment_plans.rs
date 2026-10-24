//! Pin the actual App attachment statements against the schema created at startup.
use super::*;

#[tokio::test]
async fn at_14_attachment_statements_use_keyed_and_expiry_indexes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("AT-14")?.start().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    // Read the production literals: a copied SQL string would not pin a changed query.
    let source = include_str!(
        "../../../../butler-gateway/src/gateway/application/storage/schema/canon_files.rs"
    );
    let pattern = regex::Regex::new(r#"const (\w+): &str =\s*"([^"]*)";"#).unwrap();
    let statements: Vec<_> = pattern.captures_iter(source).collect();
    assert_eq!(statements.len(), 9);
    for statement in statements {
        let name = &statement[1];
        let sql = &statement[2];
        let index = match name {
            "EPIC_FILES" | "REMOVE_REFS" => "sqlite_autoindex_app_canon_epic_files",
            "EXPIRED" | "DELETE_EXPIRED" => "app_file_pending_expiry",
            "DELETE_UNUSED" => "sqlite_autoindex_message_files",
            "SWEEP_QUEUE" | "REMOVE_SWEEP" => "sqlite_autoindex_app_file_sweep",
            "DELETE_PENDING" => "sqlite_autoindex_app_file_pending",
            "PIN_PENDING" => "app_canon_epic_files_file",
            _ => {
                return Err(HarnessError(format!(
                    "Unpinned attachment statement: {name}"
                )));
            }
        };
        let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
        let bindings = vec![rusqlite::types::Value::Null; stmt.parameter_count()];
        let plan = stmt
            .query_map(rusqlite::params_from_iter(bindings), |r| {
                r.get::<_, String>(3)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert!(
            plan.iter().any(|line| line.contains(index)),
            "{name}: {plan:?}"
        );
        if name == "SWEEP_QUEUE" {
            assert!(sql.ends_with("ORDER BY file_id LIMIT 100"), "{sql}");
        }
        assert!(
            plan.iter().all(|line| !line.contains("SCAN ")
                || line.contains("json_each")
                || line.contains("SCAN CONSTANT ROW")
                || (name == "SWEEP_QUEUE"
                    && line.contains("SCAN app_file_sweep USING COVERING INDEX"))),
            "{name}: {plan:?}"
        );
    }
    s.finish().await
}
