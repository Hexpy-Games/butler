use super::{
    source, sql,
    state::{CutoverState, WRITER_EPOCH},
};
use crate::store::{Context, Result, Transaction};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Cursor {
    phase: String,
    work: String,
    direction: String,
    delegation: String,
    feed_seq: i64,
    session: String,
    session_work: String,
}

pub fn begin(tx: &Transaction<'_>, state: CutoverState) -> Result<bool> {
    super::state::check_epoch(tx)?;
    let existing = tx
        .query_row(sql::EPOCH, [], |r| r.get::<_, i64>(0))
        .optional()?;
    if existing.is_some() {
        return Ok(false);
    }
    let state = if state == CutoverState::PostponedNoSpace {
        "postponed_no_space"
    } else {
        "pending"
    };
    tx.execute(sql::BEGIN, [state])?;
    Ok(true)
}
pub fn resume(tx: &Transaction<'_>, state: CutoverState) -> Result<bool> {
    begin(tx, state)?;
    if state == CutoverState::PostponedNoSpace {
        tx.execute(sql::POSTPONE, [])?;
        return Ok(false);
    }
    let (epoch, watermark) = tx.query_row(sql::MARKER, [], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
    })?;
    let max: i64 = tx.query_row(sql::WATERMARK, [], |r| r.get(0))?;
    if epoch == WRITER_EPOCH && max <= watermark {
        return Ok(false);
    }
    if epoch == WRITER_EPOCH {
        let cursor = Cursor {
            phase: "feed".into(),
            feed_seq: watermark,
            ..Cursor::default()
        };
        save(tx, &cursor)?;
    }
    tx.execute(sql::IMPORTING, [])?;
    Ok(true)
}

/// One source per transaction (<=500 rows and <=1 MiB decoded metadata except
/// an individually streamed large record). The caller yields the writer lane
/// after every batch; no request path scans historical tables.
pub fn batch(tx: &Transaction<'_>, ctx: &Context) -> Result<bool> {
    let raw: String = tx.query_row(sql::CURSOR, [], |r| r.get(0))?;
    let mut cursor: Cursor = serde_json::from_str(&raw)?;
    match cursor.phase.as_str() {
        "" | "works" => {
            cursor.phase = "works".into();
            let id = tx
                .query_row(sql::WORK_BATCH, params![cursor.work, 1], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?;
            if let Some(id) = id {
                import_work(tx, ctx, &id)?;
                cursor.work = id;
            } else {
                cursor.phase = "delegations".into();
            }
        }
        "delegations" => {
            if !delegation(tx, &mut cursor)? {
                cursor.phase = "directions".into();
            }
        }
        "directions" => {
            if !direction(tx, &mut cursor)? {
                cursor.phase = "feed".into();
            }
        }
        "feed" => {
            if !feed(tx, ctx, &mut cursor)? {
                switch(tx)?;
                return Ok(false);
            }
        }
        _ => return Err(crate::store::Error::Invalid("unknown cutover cursor phase")),
    }
    save(tx, &cursor)?;
    Ok(true)
}
fn save(tx: &Transaction<'_>, cursor: &Cursor) -> Result<()> {
    tx.execute(sql::SAVE_CURSOR, [serde_json::to_string(cursor)?])?;
    Ok(())
}
fn import_work(tx: &Transaction<'_>, ctx: &Context, id: &str) -> Result<()> {
    // Malformed source remains untouched and visible as needs_source. SQL/IO
    // failures abort the batch instead of silently losing it.
    let source = match source::load(tx, id) {
        Ok(source) => source,
        Err(crate::store::Error::Invalid(code)) => {
            needs_source(tx, "work", id, code)?;
            return Ok(());
        }
        Err(crate::store::Error::Json(_)) => {
            needs_source(tx, "work", id, "unreadable_metadata")?;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    if source.work["session_id"].as_str().is_none_or(str::is_empty) {
        needs_source(tx, "work", id, "unresolvable_session")?;
        return Ok(());
    }
    if super::shape::layout(&source.actions).is_err() {
        needs_source(tx, "work", id, "invalid_plan_graph")?;
        return Ok(());
    }
    if super::import::work(tx, ctx, &source, id)? {
        tx.execute(sql::COUNT_WORK, [])?;
    }
    Ok(())
}
fn delegation(tx: &Transaction<'_>, cursor: &mut Cursor) -> Result<bool> {
    let row = tx
        .query_row(sql::DELEGATION_BATCH, [&cursor.delegation], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .optional()?;
    let Some((id, root)) = row else {
        return Ok(false);
    };
    let mapped = tx
        .query_row(sql::MAPPING, params!["work", root], |r| {
            r.get::<_, String>(0)
        })
        .optional()?;
    if mapped.is_none() {
        needs_source(tx, "delegation", &id, "unresolvable_root_work")?;
    }
    tx.execute(sql::COUNT_DELEGATION, [])?;
    cursor.delegation = id;
    Ok(true)
}
fn direction(tx: &Transaction<'_>, cursor: &mut Cursor) -> Result<bool> {
    let row = tx
        .query_row(sql::DIRECTIONS, [&cursor.direction], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, String>(7)?,
            ))
        })
        .optional()?;
    let Some((id, message, body, seq, session, turn, delegation, parent)) = row else {
        return Ok(false);
    };
    let Some(turn) = turn else {
        needs_source(tx, "direction", &id, "unresolvable_turn_anchor")?;
        cursor.direction = id;
        return Ok(true);
    };
    let proven = if let Some(delegation) = delegation {
        tx.query_row(sql::MAPPING, params!["delegation", delegation], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
        .is_some()
    } else {
        false
    };
    let status = if proven && !parent.is_empty() {
        "accepted"
    } else {
        needs_source(tx, "direction", &id, "unresolvable_delegation")?;
        "needs_input"
    };
    let hash = crate::store::put_body(tx, &body)?;
    tx.execute(
        sql::INSTRUCTION,
        params![
            id,
            format!("legacy-direction:{id}"),
            session,
            json!({"origin":"migration","source_message_id":message,"parent_session_id":parent})
                .to_string(),
            hash,
            turn,
            seq,
            status
        ],
    )?;
    tx.execute(sql::MAP_DIRECTION, params![id, hash])?;
    tx.execute(sql::COUNT_DIRECTION, [])?;
    cursor.direction = id;
    Ok(true)
}
fn feed(tx: &Transaction<'_>, ctx: &Context, cursor: &mut Cursor) -> Result<bool> {
    if cursor.session.is_empty() {
        let row = tx
            .query_row(sql::FEED, [cursor.feed_seq], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .optional()?;
        let Some((seq, session)) = row else {
            return Ok(false);
        };
        cursor.feed_seq = seq;
        cursor.session = session;
    }
    let work = tx
        .query_row(
            sql::SESSION_BATCH,
            params![cursor.session, cursor.session_work],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    if let Some(id) = work {
        import_work(tx, ctx, &id)?;
        cursor.session_work = id;
    } else {
        cursor.session.clear();
        cursor.session_work.clear();
    }
    Ok(true)
}
fn switch(tx: &Transaction<'_>) -> Result<()> {
    let watermark: i64 = tx.query_row(sql::WATERMARK, [], |r| r.get(0))?;
    tx.execute(sql::SWITCH, params![WRITER_EPOCH, watermark])?;
    Ok(())
}
pub fn needs_source(tx: &Transaction<'_>, source: &str, id: &str, code: &str) -> Result<()> {
    let raw: String = tx.query_row(sql::NEEDS_SOURCE, [], |r| r.get(0))?;
    let mut entries: Vec<Value> = serde_json::from_str(&raw)?;
    let item = json!({"source":source,"id":id,"code":code});
    if !entries.contains(&item) {
        entries.push(item);
    }
    tx.execute(sql::SAVE_NEEDS_SOURCE, [serde_json::to_string(&entries)?])?;
    Ok(())
}
/// Priority import for an admitted managed message. Its own cursor is the
/// legacy_map; the background keyset walk later skips these same hashes.
pub fn session_batch(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    after: &str,
) -> Result<Option<String>> {
    let id = tx
        .query_row(sql::SESSION_BATCH, params![session, after], |r| {
            r.get::<_, String>(0)
        })
        .optional()?;
    if let Some(id) = &id {
        import_work(tx, ctx, id)?;
    }
    Ok(id)
}
