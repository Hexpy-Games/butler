//! Read models preserve source order and historical defaults.

mod context;
mod view;

use rusqlite::Connection;

use crate::btcc::work::{WorkContext, WorkTurnScope, WorkView};

use super::{StorageResult, common};

pub(in crate::btcc::storage) fn view(db: &Connection, work_id: &str) -> StorageResult<WorkView> {
    let row = common::work(db, work_id)?.ok_or_else(|| {
        common::error(
            "durable_work_record_missing",
            format!("Durable Work record is missing: {work_id}"),
        )
    })?;
    view::hydrate(db, &row)
}

pub(super) fn bound_view(db: &Connection, turn_id: &str) -> StorageResult<Option<WorkView>> {
    common::bound(db, turn_id)?
        .map(|row| view::hydrate(db, &row))
        .transpose()
}

pub(super) fn load_context(
    db: &Connection,
    scope: &WorkTurnScope,
) -> StorageResult<Option<WorkContext>> {
    common::turn(db, scope)?;
    let work = match common::bound(db, &scope.turn_id)? {
        Some(bound) if common::matches_scope(&bound, scope) => Some(bound),
        Some(_) => None,
        None => common::head(db, &scope.session_id)?
            .filter(|row| common::matches_scope(row, scope) && row.is_open()),
    };
    work.map(|row| context::hydrate(db, &row)).transpose()
}
