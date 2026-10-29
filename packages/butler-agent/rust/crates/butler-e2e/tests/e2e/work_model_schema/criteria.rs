use super::*;
#[tokio::test]
async fn criterion_upgrade_preserves_activity_sequence_and_matches_fresh_schema()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CC-upgrade")?.start().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    let fresh = rows(
        &db,
        "SELECT type,name,sql FROM sqlite_schema WHERE tbl_name IN ('canon_activity','canon_criterion_checks') ORDER BY name",
    )?;
    let old = include_str!("../../../../butler-canon/src/work_schema/activity.sql")
        .replace(",'criterion_confirmed','criterion_unconfirmed'", "");
    db.execute_batch("DROP TABLE canon_activity; DROP TABLE canon_criterion_checks;")?;
    db.execute_batch(&old)?;
    db.execute_batch("INSERT INTO canon_activity(seq,entity_id,actor_json,kind,summary,body,at) VALUES(19,'epic','{\"person\":\"app-user\",\"via\":\"app\"}','created','created',NULL,1);")?;
    let history = rows(&db, "SELECT * FROM canon_activity")?;
    drop(db);
    s.restart().await?;
    s.agent.terminate().await?;
    let db = Connection::open(&path)?;
    no_legacy(&db)?;
    assert_eq!(rows(&db, "SELECT * FROM canon_activity")?, history);
    assert_eq!(
        rows(
            &db,
            "SELECT type,name,sql FROM sqlite_schema WHERE tbl_name IN ('canon_activity','canon_criterion_checks') ORDER BY name"
        )?,
        fresh
    );
    db.execute_batch("INSERT INTO canon_activity(entity_id,actor_json,kind,summary,at) VALUES('epic','{}','criterion_confirmed','VB-03',2),('epic','{}','criterion_unconfirmed','VB-03',3);")?;
    assert_eq!(
        rows(&db, "SELECT seq FROM canon_activity ORDER BY seq")?,
        vec![
            vec![Value::Integer(19)],
            vec![Value::Integer(20)],
            vec![Value::Integer(21)]
        ]
    );
    let before = snapshot(&db)?;
    drop(db);
    s.restart().await?;
    s.agent.terminate().await?;
    let db = Connection::open(path)?;
    assert_eq!(snapshot(&db)?, before);
    s.finish().await
}
