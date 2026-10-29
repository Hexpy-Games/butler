//! Folders copied from macOS keep NFD names on Linux, where NFD and NFC name
//! different directories. File turns must use the exact path bytes, and data
//! stored by the NFC-normalizing encoder must still load.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use std::fs;
use std::path::Path;
use std::time::Duration;

use butler_core::json::{CanonicalKeyOrder, canonical_json};
use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Access, Scenario, Setup};
use butler_e2e::e2e::{HarnessError, nonce};

use super::access_tiers::{approve, delivered, paused};
use rusqlite::Connection;
use serde_json::{Value, json};

/// "한글 café" as macOS writes it: decomposed Hangul jamo and a combining accent.
const NFD_NAME: &str = "\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af} cafe\u{301}";
/// The same name composed; on Linux a different, nonexistent directory.
const NFC_NAME: &str = "한글 café";

/// Moves the scenario's data dir (the general chat's workspace) below an NFD
/// folder.
fn nfd_data(mut setup: Setup) -> Result<Setup, HarnessError> {
    assert_ne!(NFD_NAME, NFC_NAME);
    let parent = setup.sandbox.root.join("copied from mac");
    setup.sandbox.data = parent.join(NFD_NAME).join("data");
    fs::create_dir_all(&setup.sandbox.data)?;
    setup
        .placeholders
        .add("D", setup.sandbox.data.display().to_string());
    Ok(setup)
}

/// Compares entry names, not lookups: APFS resolves the NFC name to the NFD
/// folder, while it still lists only the name that was created.
fn assert_no_nfc_twin(data: &Path) {
    let parent = data.parent().unwrap().parent().unwrap();
    let names = fs::read_dir(parent)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert!(names.iter().any(|name| *name == *NFD_NAME), "{names:?}");
    assert!(
        !names.iter().any(|name| *name == *NFC_NAME),
        "a composed twin folder was created: {names:?}"
    );
}

fn btcc(s: &Scenario) -> Result<Connection, HarnessError> {
    Ok(Connection::open(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
    )?)
}

async fn send(s: &Scenario, text: &str, access_mode: &str) -> Result<Value, HarnessError> {
    let accepted =
        s.gw.send_message(json!({"chat_id": "general", "text": text,
            "access_mode": access_mode, "client_message_id": uuid::Uuid::new_v4().to_string()}))
            .await?;
    let turn_id = s.gw.accepted_turn(&accepted).await?;
    let turn =
        s.gw.wait_terminal(
            "general",
            &turn_id,
            Duration::from_secs(butler_e2e::e2e::scenario::turn_timeout()),
        )
        .await?;
    Ok(json!({"id": turn_id, "turn": turn}))
}

/// An approved read under ask-except-reads pins the NFD workspace and data
/// roots and reads the real file; the stored turn context keeps the exact path.
#[tokio::test]
async fn nfd_workspace_read_pins_and_reads_the_exact_path() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let secret = nonce();
    let setup = nfd_data(
        Setup::new("NFD-READ")?
            .cassette("TOOL-01")
            .access(Access::AskExceptReads)
            .placeholder("NONCE", &secret),
    )?;
    fs::write(
        setup.sandbox.data.join("notes.txt"),
        format!("the secret word is {secret}\n"),
    )?;
    let s = setup.start().await?;
    // General-chat reads of the data dir ask first, as in PERM-01.
    let prompt = "Read the file notes.txt in your workspace and tell me the secret word.";
    let turn_id = paused(&s, "general", prompt).await?;
    approve(&s, "general", "allow").await?;
    delivered(&s, "general", &turn_id).await?;
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let read = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "read_file")
        .expect("read_file row");
    assert_eq!(read["state"], "delivered", "{read}");
    let output = s.gw.operation_output(&turn_id, read).await?;
    assert!(output.contains(&secret), "{output}");
    let workspace = fs::canonicalize(&s.sandbox.data)?;
    let context: String = btcc(&s)?.query_row(
        "SELECT context_json FROM btcc_turns WHERE turn_id=?1",
        [&turn_id],
        |row| row.get(0),
    )?;
    assert!(
        context.contains(&format!("workspace:{}", workspace.display())),
        "stored context lost the exact workspace path"
    );
    assert_no_nfc_twin(&s.sandbox.data);
    s.finish().await
}

/// Rewrites every stored BTCC document into the bytes the NFC-normalizing
/// encoder wrote before exact strings were kept (`canonical_json` is that
/// encoder, unchanged), with the snapshot digest it stored.
fn rewrite_as_nfc_encoded(db: &Connection) -> Result<usize, HarnessError> {
    let mut changed = 0;
    for (table, key, column, filter) in [
        ("btcc_inbound_inbox", "inbox_id", "command_json", ""),
        ("btcc_turns", "turn_id", "context_json", ""),
        ("btcc_guided_tool_calls", "call_id", "arguments_json", ""),
        ("btcc_progress_events", "event_id", "event_json", ""),
        ("btcc_progress_events", "event_id", "destination_json", ""),
        (
            "btcc_records",
            "record_id",
            "content_json",
            "WHERE kind='admission_snapshot'",
        ),
    ] {
        let rows = db
            .prepare(&format!("SELECT {key},{column} FROM {table} {filter}"))?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))?
            .collect::<Result<Vec<(String, Option<String>)>, _>>()?;
        for (id, stored) in rows {
            let Some(stored) = stored else { continue };
            let value: Value = serde_json::from_str(&stored)?;
            let old = canonical_json(&value, CanonicalKeyOrder::JsPropertyEnumeration).unwrap();
            if old == stored {
                continue;
            }
            changed += 1;
            db.execute(
                &format!("UPDATE {table} SET {column}=?1 WHERE {key}=?2"),
                [&old, &id],
            )?;
            if table == "btcc_records" {
                let sha = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(&old));
                db.execute(
                    "UPDATE btcc_records SET sha256=?1 WHERE record_id=?2",
                    [&sha, &id],
                )?;
            }
        }
    }
    Ok(changed)
}

/// Write and edit land in the NFD workspace. The stored rows are then put
/// back in the NFC-normalized form earlier builds wrote; after a restart the
/// history, tool output and a follow-up turn still load from them.
#[tokio::test]
async fn nfd_workspace_write_edit_and_nfc_encoded_history_reload() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let marker = nonce();
    let mut s = nfd_data(
        Setup::new("NFD-WRITE")?
            .cassette("TOOL-02")
            .placeholder("NONCE", &marker),
    )?
    .start()
    .await?;
    let prompt = format!(
        "Create out.txt in your workspace containing exactly `alpha {marker}`, then use edit_file to change alpha to beta."
    );
    let first = send(&s, &prompt, "full_access").await?;
    assert_eq!(turn_state(&first["turn"]), "delivered", "{first}");
    let out = s.sandbox.data.join("out.txt");
    assert_eq!(
        fs::read_to_string(&out)?.trim_end(),
        format!("beta {marker}")
    );
    assert_no_nfc_twin(&s.sandbox.data);
    let turn_id = first["id"].as_str().unwrap();
    let before = tool_rows(&s.gw.messages("general").await?, turn_id);
    let edit = before
        .iter()
        .find(|row| row["safe_tool_name"] == "edit_file" && row["state"] == "delivered")
        .expect("delivered edit_file row")
        .clone();
    let edit_output = s.gw.operation_output(turn_id, &edit).await?;

    s.agent.terminate().await?;
    let changed = rewrite_as_nfc_encoded(&btcc(&s)?)?;
    assert!(changed > 0, "no stored document held the NFD path");
    s.gw = s.agent.start_again().await?;

    let messages = s.gw.messages("general").await?;
    assert_eq!(messages.len(), 2, "{messages:?}");
    assert_eq!(tool_rows(&messages, turn_id), before);
    assert_eq!(s.gw.operation_output(turn_id, &edit).await?, edit_output);
    let ro_prompt = format!("Create ro.txt in your workspace containing exactly `gamma {marker}`.");
    let second = send(&s, &ro_prompt, "read_only").await?;
    assert!(
        matches!(turn_state(&second["turn"]), "delivered" | "failed"),
        "read-only turn: {second}"
    );
    assert!(!s.sandbox.data.join("ro.txt").exists());
    let messages = s.gw.messages("general").await?;
    assert_eq!(tool_rows(&messages, turn_id), before);
    s.finish().await
}
