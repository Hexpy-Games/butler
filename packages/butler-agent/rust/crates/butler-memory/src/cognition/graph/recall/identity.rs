//! Historical identity reads inside the pinned graph snapshot.

mod members;
mod records;
mod resolve;

use rusqlite::Connection;

use crate::cognition::CognitionResult;
use crate::cognition::recall::{
    IdentityMembersResult, IdentityReadScope, IdentityResolution, IdentitySourceBinding,
};

pub(super) fn resolve(
    db: &Connection,
    node_id: &str,
    scope: &IdentityReadScope,
    parse_date: &dyn Fn(&str) -> f64,
    source_current: &mut impl FnMut(&IdentitySourceBinding) -> bool,
    now_millis: &mut impl FnMut() -> i64,
) -> CognitionResult<IdentityResolution> {
    resolve::resolve(db, node_id, scope, parse_date, source_current, now_millis)
}

pub(super) fn members(
    db: &Connection,
    target: &str,
    scope: &IdentityReadScope,
    limit: usize,
    parse_date: &dyn Fn(&str) -> f64,
    source_current: &mut impl FnMut(&IdentitySourceBinding) -> bool,
    now_millis: &mut impl FnMut() -> i64,
) -> CognitionResult<IdentityMembersResult> {
    members::select(
        db,
        target,
        scope,
        limit,
        parse_date,
        source_current,
        now_millis,
    )
}
