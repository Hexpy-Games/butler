use super::*;
pub(super) fn list(db: &Connection, input: &Value) -> Result<Value, AppStorageError> {
    let sql = if input["connector"].as_str().is_some() {
        "SELECT rule_json,match_count,signals,signal_times,announced_at FROM app_connector_rules WHERE connector=?1 AND (account IS NULL OR ?2 IS NULL OR account=?2) ORDER BY rowid"
    } else {
        "SELECT rule_json,match_count,signals,signal_times,announced_at FROM app_connector_rules WHERE ?1 IS NULL AND (account IS NULL OR ?2 IS NULL OR account=?2) ORDER BY rowid"
    };
    let mut query = db.prepare(sql).map_err(AppStorageError::sqlite)?;
    let rows = query
        .query_map(
            params![input["connector"].as_str(), input["account"].as_str()],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .map_err(AppStorageError::sqlite)?;
    let mut result = Vec::new();
    for row in rows {
        let (raw, count, signals, times, announced) = row.map_err(AppStorageError::sqlite)?;
        let mut rule = parse(&raw)?;
        rule["match_count"] = count.into();
        rule["signals"] = signals.into();
        rule["signal_times"] = parse(&times)?;
        rule["announced_at"] = json!(announced);
        result.push(rule);
    }
    Ok(json!({"rules":result}))
}
pub(super) fn get(db: &Connection, input: &Value) -> Result<Value, AppStorageError> {
    parse(
        &db.query_row(
            "SELECT rule_json FROM app_connector_rules WHERE id=?1",
            [text(input, "id")?],
            |r| r.get::<_, String>(0),
        )
        .map_err(AppStorageError::sqlite)?,
    )
}
pub(super) fn set(
    db: &mut Connection,
    subscribers: &super::super::events::EventSubscribers,
    input: Value,
    now: &str,
) -> Result<Value, AppStorageError> {
    let tx = db;
    let id = text(&input, "id")?;
    tx.execute("INSERT INTO app_connector_rules(id,connector,account,rule_json) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET connector=excluded.connector,account=excluded.account,rule_json=excluded.rule_json",
        params![id,text(&input,"connector")?,input["account"].as_str(),input.to_string()]).map_err(AppStorageError::sqlite)?;
    if tx
        .execute(
            "UPDATE app_connector_rules SET announced_at=?2 WHERE id=?1 AND announced_at IS NULL",
            params![id, now],
        )
        .map_err(AppStorageError::sqlite)?
        == 1
    {
        events::append(
            tx,
            subscribers,
            "connector.rule_announced",
            None,
            json!({"rule_id":id,"title":input["title"]})
                .as_object()
                .cloned()
                .unwrap_or_default(),
            now,
        )?;
    }
    Ok(input)
}
pub(super) fn remove(db: &Connection, input: &Value) -> Result<Value, AppStorageError> {
    db.execute(
        "DELETE FROM app_connector_rules WHERE id=?1",
        [text(input, "id")?],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(json!({"ok":true}))
}
pub(super) fn signal(db: &Connection, input: &Value, now: &str) -> Result<Value, AppStorageError> {
    super::rows::prune(db, now)?;
    let tx = db;
    let received = chrono::DateTime::parse_from_rfc3339(now)
        .map_err(|_| invalid())?
        .timestamp();
    let fresh=tx.execute("INSERT OR IGNORE INTO app_connector_signals(connector,account,dedupe_key,received_at) VALUES(?1,?2,?3,?4)",params![text(input,"connector")?,text(input,"account")?,text(input,"dedupe_key")?,received]).map_err(AppStorageError::sqlite)?;
    if fresh == 1 {
        tx.execute("UPDATE app_connector_rules SET signals=signals+1,signal_times=json_insert(signal_times,'$[#]',?4) WHERE id IN (
            SELECT j.value FROM app_connector_events e,json_each(e.matched_rules) j WHERE e.connector=?1 AND e.account=?2 AND e.dedupe_key=?3)",
            params![text(input,"connector")?,text(input,"account")?,text(&input["signal"],"ref")?,now]).map_err(AppStorageError::sqlite)?;
    }
    Ok(json!({"ok":true}))
}
