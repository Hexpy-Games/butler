//! KEEP: pins every format the Project Ledger persists or returns — the
//! record files, `ledger.jsonl` events, the compact index, rendered views,
//! publication claims and journals, the lock shard's SQLite schema, command
//! envelopes and the read-port projections — as normalized golden files in
//! `tests/golden`. A diff here is a format change: regenerate with
//! `BUTLER_UPDATE_GOLDEN=1` only when the change is intended.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "wire_formats/commands.rs"]
mod commands;
#[path = "wire_formats/effects.rs"]
mod effects;
#[path = "wire_formats/golden.rs"]
mod golden;
#[path = "wire_formats/harness.rs"]
mod harness;
#[path = "wire_formats/project_work.rs"]
mod project_work;
