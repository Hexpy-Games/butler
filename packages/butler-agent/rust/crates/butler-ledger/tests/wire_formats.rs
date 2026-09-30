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

/// Format pin: every Project Ledger format another version reads, as golden
/// files: commands with their record files and envelopes, record effects with
/// their journal, lock shard and answers, and project work with its records
/// and projections.
// test-category: format-pin
#[tokio::test]
async fn ledger_formats_match_their_goldens() {
    let mut normalizer = golden::Normalizer::new(std::path::Path::new("/unused"));
    for inode in ["1", "8354", "10000", "123456789"] {
        assert_eq!(
            normalizer.text(&format!("\"{inode}:8867\"")),
            "\"<inode>:8867\""
        );
    }
    commands::ledger_commands_keep_their_files_and_envelopes().await;
    effects::record_effects_keep_their_journal_lock_shard_and_answers().await;
    project_work::project_work_keeps_its_records_and_projections().await;
}
