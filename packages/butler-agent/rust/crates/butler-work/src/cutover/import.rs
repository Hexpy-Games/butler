use super::{
    shape,
    source::{Source, text},
    sql,
    state::{Reimport, reimport},
};
use crate::{
    store::{self, Context, Result, Transaction},
    work_chain::Chain,
    work_types::{Origin, ScopeKind},
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(super) fn stable_id(kind: &str, source: &str, key: &str) -> String {
    let mut hash = Sha256::new();
    for value in [kind, source, key] {
        hash.update((value.len() as u64).to_le_bytes());
        hash.update(value.as_bytes());
    }
    format!("{kind}_{:x}", hash.finalize())
}

/// A source and all its metadata are imported atomically within a batch. Its hash/map and the
/// caller's keyset cursor commit with its rows, so replay is a no-op.
pub(super) fn work(
    tx: &Transaction<'_>,
    ctx: &Context,
    source: &Source,
    batch: &str,
) -> Result<bool> {
    let old_id = text(&source.work, "work_id")?;
    let Some(Destination {
        id,
        note,
        existing,
        new_source,
    }) = destination(tx, source)?
    else {
        return Ok(false);
    };
    let layout = shape::layout(&source.actions)?;
    let revision = existing
        .as_ref()
        .and_then(|v| v["revision"].as_i64())
        .map_or(0, |n| n + 1);
    upsert_work(tx, ctx, source, &id, existing.as_ref(), note)?;
    let spec = brief(tx, ctx, source, &id, revision)?;
    super::target::tasks(tx, ctx, source, &id, &spec, layout)?;
    tx.execute(
        sql::BIND_IMPORTED_SPEC,
        params![id, spec["node_id"].as_str(), revision],
    )?;
    tx.execute(
        sql::MAP_WORK,
        params![old_id, id, source.hash, revision, batch],
    )?;
    super::version::remember(tx, old_id, &id, batch)?;
    if let Some(delegation) = &source.delegation_id {
        remember_alias(
            tx,
            "delegation",
            delegation,
            &id,
            &source.hash,
            revision,
            batch,
        )?;
    }
    Ok(new_source)
}

struct Destination {
    id: String,
    note: Option<&'static str>,
    existing: Option<Value>,
    new_source: bool,
}
fn destination(tx: &Transaction<'_>, source: &Source) -> Result<Option<Destination>> {
    let old_id = text(&source.work, "work_id")?;
    let mapping = tx
        .query_row(sql::MAPPING, params!["work", old_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .optional()?;
    let new_source = mapping.is_none();
    let mut id = stable_id("wk", old_id, "");
    let mut note = None;
    let mut existing = None;
    if let Some((new_id, hash, imported_revision)) = mapping {
        if hash == source.hash {
            return Ok(None);
        }
        let current = store::read_work(tx, &new_id)?;
        let revision = current["revision"].as_i64().unwrap_or(-1);
        let revision =
            if revision == imported_revision && super::version::changed(tx, old_id, &new_id)? {
                revision + 1
            } else {
                revision
            };
        match reimport(&source.hash, &hash, revision, imported_revision) {
            Reimport::Skip => return Ok(None),
            Reimport::InPlace => {
                id = new_id;
                existing = Some(current);
            }
            Reimport::Separate => {
                id = stable_id("wk", old_id, &source.hash);
                note = Some("changed_after_downgrade");
            }
        }
    }
    Ok(Some(Destination {
        id,
        note,
        existing,
        new_source,
    }))
}
fn upsert_work(
    tx: &Transaction<'_>,
    ctx: &Context,
    source: &Source,
    id: &str,
    existing: Option<&Value>,
    note: Option<&str>,
) -> Result<()> {
    let scope_kind = if text(&source.work, "scope_kind")? == "project" {
        ScopeKind::Project
    } else {
        ScopeKind::Session
    };
    let scope_ref = text(&source.work, "scope_ref")?;
    if existing.is_none() {
        store::create_work(
            tx,
            ctx,
            &store::NewWork {
                id: id.into(),
                scope_kind,
                scope_ref: scope_ref.into(),
                title: text(&source.work, "objective")?.into(),
                description: String::new(),
                origin: Origin::Migration,
                draft: false,
            },
            &store::Registration::Private,
        )?;
    }
    let state = match text(&source.work, "status")? {
        "blocked" => "blocked",
        "completed" => "done",
        "abandoned" => "cancelled",
        _ => "idle",
    };
    let previous = existing
        .and_then(|v| v["run_state"].as_str())
        .unwrap_or("idle");
    if state != previous {
        for (state, delta) in [(previous, -1), (state, 1)] {
            store::count(
                tx,
                (scope_kind.as_str(), scope_ref),
                &format!("run_state:{state}"),
                delta,
            )?;
        }
    }
    tx.execute(
        sql::IMPORT_WORK_FIELDS,
        params![
            id,
            text(&source.work, "objective")?,
            text(&source.work, "session_id")?,
            state,
            if source.delegated { 2 } else { 1 },
            note,
            ctx.now
        ],
    )?;
    Ok(())
}
fn brief(
    tx: &Transaction<'_>,
    ctx: &Context,
    source: &Source,
    id: &str,
    revision: i64,
) -> Result<Value> {
    let node_id = stable_id("sp", id, "brief");
    if revision == 0 {
        store::create_spec_node(
            tx,
            ctx,
            &store::NewSpecNode {
                id: node_id.clone(),
                scope_kind: if text(&source.work, "scope_kind")? == "project" {
                    ScopeKind::Project
                } else {
                    ScopeKind::Session
                },
                scope_ref: text(&source.work, "scope_ref")?.into(),
                work_id: Some(id.into()),
                parent_node_id: None,
                concern_id: node_id.clone(),
            },
            &store::Registration::Private,
        )?;
    }
    let hash = store::put_body(tx, text(&source.work, "objective")?)?;
    let node = tx.query_row(sql::SPEC_VERSION, [&node_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?))
    })?;
    store::publish_spec(
        tx,
        ctx,
        &node_id,
        node.0,
        &store::Publication {
            revision: revision + 1,
            body_hash: hash.clone(),
            parser_version: "brief.v1".into(),
            authoring_instruction_id: None,
            criteria: vec![],
        },
    )?;
    store::activate_spec(tx, ctx, &node_id, node.0 + 1, node.1, revision + 1)?;
    Ok(json!({"node_id":node_id,"revision":revision+1,"body_hash":hash}))
}

pub(super) fn chains<'a>(layout: &'a [Chain], id: &str) -> Vec<(String, &'a Chain)> {
    layout
        .iter()
        .enumerate()
        .map(|(i, chain)| (stable_id("ch", id, &i.to_string()), chain))
        .collect()
}

pub(super) fn remember_alias(
    tx: &Transaction<'_>,
    source: &str,
    source_id: &str,
    new_id: &str,
    hash: &str,
    revision: i64,
    batch: &str,
) -> Result<()> {
    tx.execute(
        sql::MAP_ENTITY,
        params![source, source_id, new_id, hash, revision, batch],
    )?;
    Ok(())
}
