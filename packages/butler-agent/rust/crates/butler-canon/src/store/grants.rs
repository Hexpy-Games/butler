//! Durable admission. The caller owns the BTCC IMMEDIATE transaction.
use super::*;
use rusqlite::params;
pub const CAPABILITIES: [&str; 5] = [
    "canon.read",
    "canon.epic.status",
    "canon.epic.comment",
    "canon.epic.create",
    "canon.spec.propose",
];

/// Display text is never an identity table or an authorization decision.
pub fn sanitize(value: &str) -> String {
    let mut tag = false;
    value
        .chars()
        .filter(|c| match c {
            '<' => {
                tag = true;
                false
            }
            '>' => {
                tag = false;
                false
            }
            _ => !tag && printable(*c) && !matches!(c, '`' | '*' | '[' | ']'),
        })
        .collect::<String>()
        .trim()
        .chars()
        .take(40)
        .collect()
}

fn printable(c: char) -> bool {
    c.escape_debug().count() == 1 || matches!(c, '\\' | '\'' | '"')
}

pub fn admit(tx: &Transaction<'_>, ctx: &Context, capability: &str) -> Result<Value> {
    if let Some(result) = check(tx, ctx, capability)? {
        return Ok(result);
    }
    let client = text(&ctx.actor, "client")?;
    let person = text(&ctx.actor, "person")?;
    let old = rows(
        tx,
        "SELECT * FROM canon_mcp_grants WHERE client_name=?1 AND person=?2",
        params![client, person],
    )?
    .pop();
    let id = match old.as_ref().and_then(|r| r["id"].as_str()) {
        Some(id) => id.to_owned(),
        None => crate::work_ids::IdGenerator::global_next(crate::work_ids::IdKind::Grant, ctx.now)?,
    };
    let mut requested: Vec<String> = CAPABILITIES.iter().map(|s| (*s).into()).collect();
    if let Some(row) = &old {
        let allowed: Vec<String> = serde_json::from_str(text(row, "allowed_json")?)?;
        for item in allowed {
            if !requested.contains(&item) {
                requested.push(item);
            }
        }
    }
    tx.execute("INSERT INTO canon_mcp_grants(id,client_name,client_title,person,requested_json,state,requested_at)
        VALUES(?1,?2,?3,?4,?5,'pending',?6) ON CONFLICT(client_name,person) DO UPDATE SET
        client_title=excluded.client_title,requested_json=excluded.requested_json,state='pending',requested_at=excluded.requested_at,decided_at=NULL,
        allowed_json=CASE WHEN canon_mcp_grants.state='revoked' THEN '[]' ELSE canon_mcp_grants.allowed_json END",
        params![id, client, text(&ctx.actor,"via")?, person, serde_json::to_string(&requested)?, ctx.now])?;
    emit(tx, ctx, "canon.trust_requested", &json!({"grant_id":id}))?;
    Ok(json!({"allowed":false,"code":"trust_pending"}))
}

pub fn list(db: &Connection, state: Option<&str>) -> Result<Value> {
    let mut items = if let Some(state) = state {
        rows(
            db,
            "SELECT * FROM canon_mcp_grants WHERE state=?1 ORDER BY requested_at DESC,id",
            [state],
        )?
    } else {
        rows(
            db,
            "SELECT * FROM canon_mcp_grants ORDER BY requested_at DESC,id",
            [],
        )?
    };
    for row in &mut items {
        row["requested"] = serde_json::from_str(text(row, "requested_json")?)?;
        row["allowed"] = serde_json::from_str(text(row, "allowed_json")?)?;
    }
    Ok(json!({"grants":items}))
}
pub fn decide(tx: &Transaction<'_>, ctx: &Context, id: &str, state: &str) -> Result<Value> {
    if !matches!(state, "allowed" | "denied" | "revoked") {
        return Err(Error::Invalid("grant state"));
    }
    if tx.execute(
        "UPDATE canon_mcp_grants SET state=?2,decided_at=?3,
        allowed_json=CASE WHEN ?2='allowed' THEN requested_json ELSE '[]' END WHERE id=?1",
        params![id, state, ctx.now],
    )? == 0
    {
        return Err(Error::NotFound);
    }
    emit(
        tx,
        ctx,
        "canon.trust_changed",
        &json!({"grant_id":id,"state":state}),
    )?;
    Ok(json!({"grant_id":id,"state":state}))
}
pub(super) fn emit(
    tx: &Transaction<'_>,
    ctx: &Context,
    topic: &str,
    payload: &Value,
) -> Result<()> {
    tx.execute(sql::OUTBOX, params![topic, payload.to_string(), ctx.now])?;
    Ok(())
}

/// None means admission must upsert/reopen a grant on the writer lane.
pub fn check(db: &Connection, ctx: &Context, capability: &str) -> Result<Option<Value>> {
    let client = text(&ctx.actor, "client")?;
    let person = text(&ctx.actor, "person")?;
    let old = rows(
        db,
        "SELECT * FROM canon_mcp_grants WHERE client_name=?1 AND person=?2",
        params![client, person],
    )?
    .pop();
    if let Some(row) = &old {
        let allowed: Vec<String> = serde_json::from_str(text(row, "allowed_json")?)?;
        if matches!(row["state"].as_str(), Some("pending" | "allowed"))
            && allowed.iter().any(|s| s == capability)
        {
            return Ok(Some(json!({"allowed":true})));
        }
        if row["state"] == "denied" {
            return Ok(Some(json!({"allowed":false,"code":"permission"})));
        }
        if row["state"] == "pending" {
            return Ok(Some(json!({"allowed":false,"code":"trust_pending"})));
        }
    }
    Ok(None)
}
/// Recheck in the same snapshot/transaction as the delegated operation.
pub fn require(db: &Connection, ctx: &Context, capability: &str) -> Result<()> {
    if check(db, ctx, capability)?.is_some_and(|r| r["allowed"] == true) {
        Ok(())
    } else {
        Err(Error::Permission)
    }
}
