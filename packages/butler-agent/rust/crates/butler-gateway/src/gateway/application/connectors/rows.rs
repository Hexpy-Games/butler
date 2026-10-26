use super::*;
pub(super) fn insert(
    db: &Connection,
    mut event: Value,
    now: &str,
) -> Result<Value, AppStorageError> {
    let received = chrono::DateTime::parse_from_rfc3339(text(&event, "received_at")?)
        .map_err(|_| invalid())?
        .timestamp();
    prune(db, now)?;
    let tx = db;
    let id = format!("event-{}", uuid::Uuid::new_v4());
    event["event_id"] = id.clone().into();
    let fresh=tx.execute("INSERT OR IGNORE INTO app_connector_events(event_id,connector,account,dedupe_key,received_at,data_json,arrived_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![id,text(&event,"connector")?,text(&event,"account")?,text(&event,"dedupe_key")?,received,event.to_string(),now]).map_err(AppStorageError::sqlite)?==1;
    let (id, fresh) = if fresh {
        (id, true)
    } else {
        tx.query_row("SELECT event_id,ready=0 FROM app_connector_events WHERE connector=?1 AND account=?2 AND dedupe_key=?3",params![text(&event,"connector")?,text(&event,"account")?,text(&event,"dedupe_key")?],|r|Ok((r.get(0)?,r.get(1)?))).map_err(AppStorageError::sqlite)?
    };
    Ok(json!({"fresh":fresh,"event_id":id}))
}
pub(super) fn ready(db: &mut Connection, input: &Value) -> Result<Value, AppStorageError> {
    let tx = db;
    tx.execute("UPDATE app_connector_events SET ready=1,matched_rules=?2,actions_json=?3,skip_model=?4,tags=?5,skip_rules=?6 WHERE event_id=?1",
        params![text(input,"event_id")?,input["matched_rules"].to_string(),input["actions"].to_string(),input["skip_model"]==true,input["tags"].to_string(),input["skip_rules"].to_string()]).map_err(AppStorageError::sqlite)?;
    for id in input["matched_rules"].as_array().into_iter().flatten() {
        tx.execute(
            "UPDATE app_connector_rules SET match_count=match_count+1 WHERE id=?1",
            [id.as_str().ok_or_else(invalid)?],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    Ok(json!({"ok":true}))
}
pub(super) fn pending(db: &Connection, input: &Value) -> Result<Value, AppStorageError> {
    let mut q=db.prepare("SELECT data_json,matched_rules,skip_model,arrived_at,skip_rules FROM app_connector_events WHERE account=?1 AND ready=1 AND delivered_at IS NULL AND digested_at IS NULL ORDER BY rowid").map_err(AppStorageError::sqlite)?;
    let rows = q
        .query_map([text(input, "account")?], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(AppStorageError::sqlite)?;
    let mut result = Vec::new();
    for row in rows {
        let (data, rules, skip, arrived, skip_rules) = row.map_err(AppStorageError::sqlite)?;
        let mut event = parse(&data)?;
        event["matched_rules"] = parse(&rules)?;
        event["skip_model"] = skip.into();
        event["arrived_at"] = arrived.into();
        event["skip_rules"] = parse(&skip_rules)?;
        result.push(event);
    }
    Ok(json!({"rows":result}))
}
pub(super) fn event(db: &Connection, input: &Value) -> Result<Value, AppStorageError> {
    let data = db
        .query_row(
            "SELECT data_json FROM app_connector_events WHERE event_id=?1",
            [text(input, "event_id")?],
            |r| r.get::<_, String>(0),
        )
        .map_err(AppStorageError::sqlite)?;
    parse(&data)
}
pub(super) fn triage(db: &mut Connection, input: &Value) -> Result<Value, AppStorageError> {
    let tx = db;
    for item in input["items"].as_array().ok_or_else(invalid)? {
        let lane = text(item, "lane")?;
        if !matches!(lane, "now" | "later" | "quiet") {
            return Err(invalid());
        }
        if tx
            .execute(
                "UPDATE app_connector_events SET lane=?2 WHERE event_id=?1",
                params![text(item, "event_id")?, lane],
            )
            .map_err(AppStorageError::sqlite)?
            != 1
        {
            return Err(invalid());
        }
    }
    Ok(json!({"ok":true}))
}

pub(super) fn unfinished(db: &Connection, input: &Value) -> Result<Value, AppStorageError> {
    let mut query=db.prepare("SELECT data_json FROM app_connector_events WHERE account=?1 AND ready=0 ORDER BY rowid").map_err(AppStorageError::sqlite)?;
    let rows = query
        .query_map([text(input, "account")?], |r| r.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?;
    let mut events = Vec::new();
    for row in rows {
        events.push(parse(&row.map_err(AppStorageError::sqlite)?)?);
    }
    Ok(json!({"rows":events}))
}

pub(super) fn batch(
    db: &mut Connection,
    input: &Value,
    now: &str,
) -> Result<Value, AppStorageError> {
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    for event in input["events"].as_array().ok_or_else(invalid)? {
        if event["signal"].is_null() {
            insert(&tx, event.clone(), now)?;
        } else {
            super::rules::signal(&tx, event, now)?;
        }
    }
    tx.execute("INSERT INTO app_connector_cursors(account,cursor) VALUES(?1,?2) ON CONFLICT(account) DO UPDATE SET cursor=excluded.cursor",params![text(input,"account")?,text(input,"cursor")?]).map_err(AppStorageError::sqlite)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(json!({"ok":true}))
}

/// Both event and signal intake retain the same bounded source history.
pub(super) fn prune(db: &Connection, now: &str) -> Result<(), AppStorageError> {
    let cutoff = chrono::DateTime::parse_from_rfc3339(now)
        .map_err(|_| invalid())?
        .timestamp()
        - 30 * 86400;
    let tx = db;
    tx.execute(
        "DELETE FROM app_connector_events WHERE arrived_at<?1 AND (delivered_at IS NOT NULL OR digested_at IS NOT NULL)",
        [chrono::DateTime::from_timestamp(cutoff, 0).ok_or_else(invalid)?.to_rfc3339()],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.execute(
        "DELETE FROM app_connector_signals WHERE received_at<?1",
        [cutoff],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.execute(
        "DELETE FROM app_connector_deliveries WHERE created_at<?1 AND admitted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_connector_events WHERE delivery_id=app_connector_deliveries.id)",
        [cutoff],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}
