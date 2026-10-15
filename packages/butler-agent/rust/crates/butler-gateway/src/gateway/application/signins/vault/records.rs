//! Vault rows. Callers own the enclosing transaction; values never include secrets.
use super::{AppCardInput, AppProfileInput, AppVaultCommand};
use crate::gateway::application::AppStorageError;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, AppStorageError>;
fn sql(error: rusqlite::Error) -> AppStorageError {
    AppStorageError::sqlite(error)
}

const CARD_COLUMNS: &str = "id,nickname,brand,last4,exp_month,exp_year,holder_name,billing_json,extras_json,created_at,last_used_at";
const AUTOFILL_COLUMNS: &str = "id,nickname,details_json,extras_json,created_at,last_used_at";

fn parsed(text: &str, fallback: Value) -> Value {
    serde_json::from_str(text).unwrap_or(fallback)
}

fn card_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?, "nickname": row.get::<_, String>(1)?,
        "brand": row.get::<_, String>(2)?, "last4": row.get::<_, String>(3)?,
        "exp_month": row.get::<_, i64>(4)?, "exp_year": row.get::<_, i64>(5)?,
        "holder_name": row.get::<_, String>(6)?,
        "billing": parsed(&row.get::<_, String>(7)?, json!({})),
        "extras": parsed(&row.get::<_, String>(8)?, json!([])),
        "created_at": row.get::<_, String>(9)?, "last_used_at": row.get::<_, Option<String>>(10)?,
    }))
}

fn autofill_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?, "nickname": row.get::<_, String>(1)?,
        "details": parsed(&row.get::<_, String>(2)?, json!({})),
        "extras": parsed(&row.get::<_, String>(3)?, json!([])),
        "created_at": row.get::<_, String>(4)?, "last_used_at": row.get::<_, Option<String>>(5)?,
    }))
}

type RowFn = fn(&rusqlite::Row<'_>) -> rusqlite::Result<Value>;

fn table(kind: &str) -> (&'static str, &'static str, RowFn) {
    if kind == "card" {
        ("browser_payment_cards", CARD_COLUMNS, card_row)
    } else {
        ("browser_autofill_profiles", AUTOFILL_COLUMNS, autofill_row)
    }
}

fn items(db: &Connection, kind: &str) -> Result<Vec<Value>> {
    let (name, columns, row) = table(kind);
    let mut statement = db
        .prepare(&format!(
            "SELECT {columns} FROM {name} ORDER BY created_at, id LIMIT 200"
        ))
        .map_err(sql)?;
    let rows = statement.query_map([], row).map_err(sql)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)
}

fn item(db: &Connection, kind: &str, id: &str) -> Result<Option<Value>> {
    let (name, columns, row) = table(kind);
    db.query_row(
        &format!("SELECT {columns} FROM {name} WHERE id=?1"),
        [id],
        row,
    )
    .optional()
    .map_err(sql)
}

fn strings(db: &Connection, query: &str, values: &[&str]) -> Result<Vec<String>> {
    let mut statement = db.prepare(query).map_err(sql)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(values), |row| {
            row.get::<_, String>(0)
        })
        .map_err(sql)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)
}

fn sites(db: &Connection, kind: &str, id: &str) -> Result<Vec<String>> {
    strings(
        db,
        "SELECT site FROM browser_vault_sites WHERE kind=?1 AND item_id=?2 ORDER BY site",
        &[kind, id],
    )
}

fn uses(db: &Connection, kind: &str, id: &str) -> Result<Vec<Value>> {
    let mut statement = db
        .prepare(
            "SELECT result,origin,created_at FROM browser_vault_audit \
             WHERE kind=?1 AND item_id=?2 ORDER BY id DESC LIMIT 3",
        )
        .map_err(sql)?;
    let rows = statement
        .query_map(params![kind, id], |row| {
            Ok(json!({"result": row.get::<_, String>(0)?, "origin": row.get::<_, String>(1)?, "at": row.get::<_, String>(2)?}))
        })
        .map_err(sql)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)
}

pub(super) fn read(db: &Connection, command: AppVaultCommand) -> Result<Value> {
    match command {
        AppVaultCommand::List => list(db),
        AppVaultCommand::Item { kind, id } => Ok(json!({"item": item(db, kind, &id)?})),
        AppVaultCommand::ForSite { site } => for_site(db, &site),
        AppVaultCommand::PurchaseAllowed { site } => {
            let allowed = db
                .query_row(
                    "SELECT 1 FROM browser_purchase_sites WHERE site=?1",
                    [&site],
                    |_| Ok(()),
                )
                .optional()
                .map_err(sql)?
                .is_some();
            Ok(json!({"allowed": allowed}))
        }
        _ => Ok(Value::Null),
    }
}

fn list(db: &Connection) -> Result<Value> {
    let mut view = json!({});
    for (kind, key) in [("card", "cards"), ("profile", "profiles")] {
        let mut rows = items(db, kind)?;
        for row in &mut rows {
            let id = row["id"].as_str().unwrap_or("").to_owned();
            row["sites"] = json!(sites(db, kind, &id)?);
            row["uses"] = json!(uses(db, kind, &id)?);
        }
        view[key] = json!(rows);
    }
    view["purchase_sites"] = json!(strings(
        db,
        "SELECT site FROM browser_purchase_sites ORDER BY site LIMIT 500",
        &[]
    )?);
    Ok(view)
}

/// What the model may see for a fill: nicknames, last four digits and the
/// fields on file, plus whether the user allows the item on this site
/// without asking.
fn for_site(db: &Connection, site: &str) -> Result<Value> {
    let mut cards = Vec::new();
    for card in items(db, "card")? {
        let id = card["id"].as_str().unwrap_or("");
        let allowed = sites(db, "card", id)?.iter().any(|s| s == site);
        cards.push(
            json!({"id": id, "nickname": card["nickname"], "brand": card["brand"],
            "last4": card["last4"], "exp_month": card["exp_month"], "exp_year": card["exp_year"],
            "holder_name": card["holder_name"], "extras": card["extras"], "allowed": allowed}),
        );
    }
    let mut profiles = Vec::new();
    for autofill in items(db, "profile")? {
        let id = autofill["id"].as_str().unwrap_or("");
        let mut fields: Vec<String> = autofill["details"]
            .as_object()
            .map(|details| {
                details
                    .keys()
                    .map(|key| {
                        if key == "name" {
                            "full_name".to_owned()
                        } else {
                            key.clone()
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        fields.extend(
            serde_json::from_value::<Vec<String>>(autofill["extras"].clone()).unwrap_or_default(),
        );
        let allowed = sites(db, "profile", id)?.iter().any(|s| s == site);
        profiles.push(json!({"id": id, "nickname": autofill["nickname"],
            "fields": fields, "allowed": allowed}));
    }
    Ok(json!({"cards": cards, "profiles": profiles}))
}

pub(super) fn write(
    db: &Connection,
    command: AppVaultCommand,
    now: &str,
    id: &str,
) -> Result<Value> {
    match command {
        AppVaultCommand::InsertCard(input) => {
            upsert_card(db, None, id, &input, now)?;
            Ok(json!({"id": id}))
        }
        AppVaultCommand::UpdateCard { id, input } => upsert_card(db, Some(&id), &id, &input, now),
        AppVaultCommand::InsertProfile(input) => {
            upsert_autofill(db, None, id, &input, now)?;
            Ok(json!({"id": id}))
        }
        AppVaultCommand::UpdateProfile { id, input } => {
            upsert_autofill(db, Some(&id), &id, &input, now)
        }
        AppVaultCommand::Delete { kind, id } => {
            let (name, _, _) = table(kind);
            let removed = db
                .execute(&format!("DELETE FROM {name} WHERE id=?1"), [&id])
                .map_err(sql)?;
            db.execute(
                "DELETE FROM browser_vault_sites WHERE kind=?1 AND item_id=?2",
                params![kind, id],
            )
            .map_err(sql)?;
            Ok(json!({"removed": removed > 0}))
        }
        other @ (AppVaultCommand::SetSite { .. }
        | AppVaultCommand::PurchaseSite { .. }
        | AppVaultCommand::Audit { .. }) => record(db, other, now),
        read_only => read(db, read_only),
    }
}

/// Allowances and audit rows.
fn record(db: &Connection, command: AppVaultCommand, now: &str) -> Result<Value> {
    match command {
        AppVaultCommand::SetSite {
            kind,
            id,
            site,
            allow,
        } => {
            let changed = if allow {
                db.execute(
                    "INSERT OR IGNORE INTO browser_vault_sites(kind,item_id,site,created_at) VALUES(?1,?2,?3,?4)",
                    params![kind, id, site, now],
                )
            } else {
                db.execute(
                    "DELETE FROM browser_vault_sites WHERE kind=?1 AND item_id=?2 AND site=?3",
                    params![kind, id, site],
                )
            }
            .map_err(sql)?;
            Ok(json!({"changed": changed > 0}))
        }
        AppVaultCommand::PurchaseSite { site, allow } => {
            let changed = if allow {
                db.execute(
                    "INSERT OR IGNORE INTO browser_purchase_sites(site,created_at) VALUES(?1,?2)",
                    params![site, now],
                )
            } else {
                db.execute("DELETE FROM browser_purchase_sites WHERE site=?1", [&site])
            }
            .map_err(sql)?;
            Ok(json!({"changed": changed > 0}))
        }
        AppVaultCommand::Audit {
            kind,
            item_id,
            session,
            turn,
            origin,
            frame_origin,
            result,
        } => {
            db.execute(
                "INSERT INTO browser_vault_audit(kind,item_id,session_id,turn_id,origin,frame_origin,result,created_at) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![kind, item_id, session, turn, origin, frame_origin, result, now],
            )
            .map_err(sql)?;
            let (name, _, _) = table(kind);
            db.execute(
                &format!("UPDATE {name} SET last_used_at=?1 WHERE id=?2"),
                params![now, item_id],
            )
            .map_err(sql)?;
            Ok(json!({"recorded": true}))
        }
        _ => Ok(Value::Null),
    }
}

fn upsert_card(
    db: &Connection,
    existing: Option<&str>,
    id: &str,
    input: &AppCardInput,
    now: &str,
) -> Result<Value> {
    let (billing, extras) = (input.billing.to_string(), json!(input.extras).to_string());
    let changed = if existing.is_some() {
        db.execute(
            "UPDATE browser_payment_cards SET nickname=?2,brand=?3,last4=?4,exp_month=?5,exp_year=?6,holder_name=?7,billing_json=?8,extras_json=?9 WHERE id=?1",
            params![id, input.nickname, input.brand, input.last4, input.exp_month, input.exp_year,
                input.holder_name, billing, extras],
        )
    } else {
        db.execute(
            "INSERT INTO browser_payment_cards(id,nickname,brand,last4,exp_month,exp_year,holder_name,billing_json,extras_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![id, input.nickname, input.brand, input.last4, input.exp_month, input.exp_year,
                input.holder_name, billing, extras, now],
        )
    }
    .map_err(sql)?;
    Ok(json!({"changed": changed > 0}))
}

fn upsert_autofill(
    db: &Connection,
    existing: Option<&str>,
    id: &str,
    input: &AppProfileInput,
    now: &str,
) -> Result<Value> {
    let (details, extras) = (input.details.to_string(), json!(input.extras).to_string());
    let changed = if existing.is_some() {
        db.execute(
            "UPDATE browser_autofill_profiles SET nickname=?2,details_json=?3,extras_json=?4 WHERE id=?1",
            params![id, input.nickname, details, extras],
        )
    } else {
        db.execute(
            "INSERT INTO browser_autofill_profiles(id,nickname,details_json,extras_json,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![id, input.nickname, details, extras, now],
        )
    }
    .map_err(sql)?;
    Ok(json!({"changed": changed > 0}))
}
