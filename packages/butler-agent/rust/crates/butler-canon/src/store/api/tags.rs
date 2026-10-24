//! Canon-only categorical tags, executed on the owning storage lane.
use super::*;
use caseless::Caseless;
use rusqlite::params;
use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

pub fn name_key(name: &str) -> String {
    name.nfc().default_case_fold().nfc().collect()
}
fn name(value: &str) -> Result<(&str, String)> {
    let name = value.trim();
    if !(1..=32).contains(&name.chars().count()) {
        return Err(Error::Invalid("tag name must contain 1–32 characters"));
    }
    Ok((name, name_key(name)))
}
fn collision(db: &Connection, project: &str, key: &str, id: Option<&str>) -> Result<()> {
    if let Some(existing) = rows(db, sql::TAG_NAME, params![project, key])?
        .into_iter()
        .next()
        && existing["id"].as_str() != id
    {
        return Err(Error::TagExists { existing });
    }
    Ok(())
}
fn color(color: &str) -> Result<()> {
    if ![
        "gray", "red", "orange", "yellow", "green", "teal", "blue", "purple",
    ]
    .contains(&color)
    {
        return Err(Error::Invalid("invalid tag color"));
    }
    Ok(())
}
pub fn list(db: &Connection, project: &str) -> Result<Value> {
    Ok(json!(rows(db, sql::TAGS, [project])?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewTag {
    name: String,
    color: String,
}
pub(super) fn create(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    value: Value,
) -> Result<Value> {
    let input: NewTag = input(value)?;
    let (name, key) = name(&input.name)?;
    color(&input.color)?;
    collision(tx, project, &key, None)?;
    let id = IdGenerator::global_next(IdKind::Tag, ctx.now)?;
    tx.execute(
        sql::INSERT_TAG,
        params![
            id,
            project,
            name,
            key,
            input.color,
            ctx.now,
            ctx.actor.to_string()
        ],
    )?;
    event(tx, ctx, "tag", &id, 0, "create")?;
    one(tx, sql::TAG, [id])
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TagEdit {
    expected_revision: i64,
    name: Option<String>,
    color: Option<String>,
}
pub(super) fn edit(tx: &Transaction<'_>, ctx: &Context, id: &str, value: Value) -> Result<Value> {
    let input: TagEdit = input(value)?;
    let old = one(tx, sql::TAG, [id])?;
    cas(&old, "revision", input.expected_revision)?;
    let (name, key) = name(input.name.as_deref().unwrap_or(text(&old, "name")?))?;
    let tone = input.color.as_deref().unwrap_or(text(&old, "color")?);
    color(tone)?;
    collision(tx, text(&old, "project_id")?, &key, Some(id))?;
    tx.execute(
        sql::EDIT_TAG,
        params![id, name, key, tone, ctx.now, input.expected_revision],
    )?;
    event(tx, ctx, "tag", id, input.expected_revision + 1, "edit")?;
    one(tx, sql::TAG, [id])
}
pub(super) fn delete(tx: &Transaction<'_>, ctx: &Context, id: &str) -> Result<Value> {
    let tag = one(tx, sql::TAG, [id])?;
    let epics = rows(tx, sql::TAG_EPICS, [id])?;
    // Append while the tag's project identity still exists; commit atomically.
    event(tx, ctx, "tag", id, revision(&tag)?, "delete")?;
    tx.execute(sql::DELETE_TAG, [id])?;
    for epic in epics {
        event(
            tx,
            ctx,
            "work",
            text(&epic, "id")?,
            revision(&epic)?,
            "tag_delete",
        )?;
    }
    Ok(json!({"id":id}))
}
pub(super) fn replace(
    tx: &Transaction<'_>,
    ctx: &Context,
    epic: &Value,
    tags: &[String],
) -> Result<()> {
    for id in tags {
        let tag = rows(tx, sql::TAG, [id])?.into_iter().next();
        if tag.is_none_or(|tag| tag["project_id"] != epic["project_id"]) {
            return Err(Error::Conflict {
                current: epic.clone(),
            });
        }
    }
    let id = text(epic, "id")?;
    tx.execute(sql::CLEAR_TAGS, [id])?;
    for tag in tags {
        tx.execute(sql::ASSIGN_TAG, params![id, tag])?;
    }
    let rev = revision(epic)?;
    tx.execute(sql::BUMP_EPIC, params![id, ctx.now, rev])?;
    event(tx, ctx, "work", id, rev + 1, "tags")
}
