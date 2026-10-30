//! Durable rolling context for one canonical conversation, independent of profiling.
use butler_turn::conversation::ContinuityTurn;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
};

/// Provenance text injected above a stored summary.
pub const HEADER: &str = "Summary of earlier turns of this chat, kept by Butler. Facts here were established in this chat; read_conversation_context returns exact wording.";
/// Stable instructions for the rolling summarizer.
pub const INSTRUCTIONS: &str = "You keep the running summary of one chat so its assistant can continue the chat after older turns leave its view. You receive the current summary and the next turns, oldest first. Return only the full updated summary, in the chat's main language, as Markdown with these sections; omit a section only when it has nothing:\n## Facts and entities\nEvery named or referenced person, animal, object, place or project, with each attribute the chat established: kind, species, sex, age, dates, names, numbers, state. Carry every fact from the current summary forward unchanged unless a later turn corrects it; then keep the corrected value.\n## Decisions and preferences\nWhat the user decided, asked for, or ruled out in this chat.\n## Open threads\nQuestions, promises and tasks not yet resolved.\n## Story so far\nA few lines on what happened, in order.\nRecord only what the turns state. A turn marked failed, cancelled or interrupted did not establish its answer; keep only what its user message says. Never invent, guess or generalize. Keep the whole summary under 6,000 characters; when space runs short, shorten Story so far first and never drop a fact.";
const PREFIX: &str = "<!-- butler-continuity ";

/// Summary text and its canonical message progress marker.
#[derive(Default)]
pub struct Summary {
    /// Last folded canonical message sequence.
    pub through_seq: u64,
    /// Full Markdown returned by the summarizer.
    pub text: String,
}

#[derive(Serialize, Deserialize)]
struct Marker {
    v: u8,
    through_seq: u64,
    model: String,
    updated_at: String,
}

/// Destination bound to the canonical conversation identity.
fn path(root: &Path, session: &str) -> PathBuf {
    let mut key = format!("{:x}", Sha256::digest(session.as_bytes()));
    key.truncate(32);
    root.join("sessions").join(format!("{key}.md"))
}

/// Blocking file operations must be called on the host's tracked blocking lane.
pub fn read(root: &Path, session: &str) -> io::Result<Summary> {
    let content = match fs::read_to_string(path(root, session)) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Summary::default()),
        Err(error) => return Err(error),
    };
    if !content.starts_with(PREFIX) {
        return Ok(Summary {
            through_seq: 0,
            text: content,
        });
    }
    let (line, text) = content
        .split_once('\n')
        .ok_or_else(|| io::Error::other("Invalid continuity marker"))?;
    let marker = line
        .strip_prefix(PREFIX)
        .and_then(|s| s.strip_suffix(" -->"))
        .ok_or_else(|| io::Error::other("Invalid continuity marker"))?;
    let marker: Marker = serde_json::from_str(marker).map_err(io::Error::other)?;
    if marker.v != 1 {
        return Err(io::Error::other("Unsupported continuity version"));
    }
    Ok(Summary {
        through_seq: marker.through_seq,
        text: text.to_owned(),
    })
}

/// Atomically replaces one batch using a private file in the same directory.
pub fn write(root: &Path, session: &str, summary: &Summary, model: &str) -> io::Result<()> {
    let destination = path(root, session);
    butler_platform::secure_fs::create_private_dir_all(&root.join("sessions"))?;
    let marker = serde_json::to_string(&Marker {
        v: 1,
        through_seq: summary.through_seq,
        model: model.into(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    })
    .map_err(io::Error::other)?;
    let body = format!("{PREFIX}{marker} -->\n{}", summary.text);
    butler_platform::secure_fs::replace_private(
        &destination,
        |file| file.write_all(body.as_bytes()),
        |e| e,
    )
}

/// Removes the chat projection after permanent deletion.
pub fn remove(root: &Path, session: &str) -> io::Result<()> {
    match fs::remove_file(path(root, session)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Full prior summary plus the next canonical turns, oldest first.
pub fn prompt(previous: &str, turns: &[ContinuityTurn]) -> String {
    let previous = if previous.is_empty() {
        "(none)"
    } else {
        previous
    };
    let mut text = format!("Current summary:\n{previous}\n\nNext turns, oldest first:");
    for turn in turns {
        let label = if matches!(turn.status.as_str(), "failed" | "cancelled" | "interrupted") {
            format!("butler ({}, not established)", turn.status)
        } else {
            "butler".into()
        };
        let answer = if turn.answer.is_empty() {
            "(no answer)"
        } else {
            &turn.answer
        };
        text.push_str(&format!(
            "\n[turn {}, {}]\nuser: {}",
            turn.number, turn.status, turn.user
        ));
        if !turn.hook_context.is_empty() {
            text.push('\n');
            text.push_str(&turn.hook_context);
        }
        text.push_str(&format!("\n{label}: {answer}"));
        if !turn.tools.is_empty() {
            text.push_str(&format!("\ntools used: {}", turn.tools.join(", ")));
        }
    }
    text
}
