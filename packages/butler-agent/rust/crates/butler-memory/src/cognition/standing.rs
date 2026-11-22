//! A generation's standing-fact sheet, folded from global user claims.
use std::{fs, io, io::Write, path::Path};

use serde::{Deserialize, Serialize};

use super::{CognitionCode, CognitionError, CognitionResult, graph::GraphRepository};

/// Maximum sheet text in UTF-8 bytes.
pub const MAX_BYTES: usize = 4 * 1024;
const BATCH_BYTES: usize = 12 * 1024;
/// Provenance text injected above the sheet.
pub(super) const HEADER: &str = "What Butler knows about the user, kept by Butler from earlier chats. It can be out of date; check with the user or recall_memory before relying on it for anything that matters. Use it to understand what the user refers to; do not bring it up unprompted.";
/// Stable instructions for maintaining the sheet.
pub const INSTRUCTIONS: &str = "You keep a short fact sheet about one person, the user of a personal assistant, so the assistant always knows the lasting facts of their life without looking them up. You receive the current sheet and new statements the user made in chats, oldest first, each with its date. Return only the full updated sheet, in the user's main language, as short Markdown bullet lines under a few headings of your choice.
Keep what will probably still be true and useful months from now: who the user is, where they live and work, the people and animals in their life and what each name refers to (kind, species, sex, relation, dates), what they own or run, their ongoing projects, hobbies and routines, and lasting preferences. Write each line so it stands alone: name the thing and say what it is. When several names plainly refer to the same thing, put them on one line.
Leave out one-off events and passing states such as a meal, an errand, a symptom or a single question; instructions about how the assistant should behave; details of software work in progress; and secrets such as passwords, keys, account numbers and ID numbers.
Carry every line of the current sheet forward unchanged unless a new statement corrects it or space runs out. A later statement overrides an earlier one. When something ended (a pet died, a plan was dropped, the user moved), keep one line that says so with its date instead of deleting it. Record only what the statements say; never guess or generalize. If the new statements add nothing lasting, return the current sheet unchanged.
The sheet must fit in 4,096 UTF-8 bytes, which is about 1,300 Korean characters or 4,000 English letters. When space runs short, drop the least lasting and least useful lines first.";
const PREFIX: &str = "<!-- butler-standing ";

/// Sheet text and its global claim progress marker.
#[derive(Default)]
pub struct Sheet {
    /// Creation time of the last folded claim.
    pub through_at: String,
    /// Id of the last folded claim.
    pub through_id: String,
    /// Number of current source claims through the cursor.
    pub sources: u64,
    /// Full Markdown returned by the memory model.
    pub text: String,
}

/// The next statement lines and their progress marker.
pub struct Batch {
    /// Dated user statements, oldest first.
    pub lines: String,
    /// Creation time of the last included claim.
    pub through_at: String,
    /// Id of the last included claim.
    pub through_id: String,
    /// Number of current source claims through the cursor.
    pub sources: u64,
}

#[derive(Serialize, Deserialize)]
struct Marker {
    v: u8,
    through_at: String,
    through_id: String,
    sources: u64,
    model: String,
    updated_at: String,
}

pub(super) fn read(root: &Path) -> io::Result<Sheet> {
    let content = match fs::read_to_string(root.join("hot/standing.md")) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Sheet::default()),
        Err(error) => return Err(error),
    };
    if !content.starts_with(PREFIX) {
        return Ok(Sheet::default());
    }
    let (line, text) = content
        .split_once('\n')
        .ok_or_else(|| io::Error::other("Invalid standing marker"))?;
    let marker = line
        .strip_prefix(PREFIX)
        .and_then(|s| s.strip_suffix(" -->"))
        .ok_or_else(|| io::Error::other("Invalid standing marker"))?;
    let marker: Marker = serde_json::from_str(marker).map_err(io::Error::other)?;
    if marker.v != 1 {
        return Err(io::Error::other("Unsupported standing version"));
    }
    Ok(Sheet {
        through_at: marker.through_at,
        through_id: marker.through_id,
        sources: marker.sources,
        text: text.to_owned(),
    })
}

/// Atomically replaces the sheet with a private file in the same directory.
pub fn write(root: &Path, sheet: &Sheet, model: &str) -> io::Result<()> {
    butler_platform::secure_fs::create_private_dir_all(&root.join("hot"))?;
    let marker = serde_json::to_string(&Marker {
        v: 1,
        through_at: sheet.through_at.clone(),
        through_id: sheet.through_id.clone(),
        sources: sheet.sources,
        model: model.into(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    })
    .map_err(io::Error::other)?;
    let body = format!("{PREFIX}{marker} -->\n{}", sheet.text);
    butler_platform::secure_fs::replace_private(
        &root.join("hot/standing.md"),
        |file| file.write_all(body.as_bytes()),
        |e| e,
    )
}

/// Reads the next bounded batch in one graph snapshot.
pub fn batch(graph_path: &Path, sheet: &Sheet) -> CognitionResult<Option<Batch>> {
    let graph = GraphRepository::open_read_snapshot(graph_path)?;
    let rows = graph.standing_rows(&sheet.through_at, &sheet.through_id, 400)?;
    let mut batch = Batch {
        lines: String::new(),
        through_at: String::new(),
        through_id: String::new(),
        sources: 0,
    };
    for (at, id, date, statement) in rows {
        let statement = statement.split_whitespace().collect::<Vec<_>>().join(" ");
        let line = format!("[{date}] {statement}");
        if !batch.lines.is_empty() {
            if batch.lines.len() + 1 + line.len() > BATCH_BYTES {
                break;
            }
            batch.lines.push('\n');
        }
        batch.lines.push_str(&line);
        batch.through_at = at;
        batch.through_id = id;
    }
    if batch.lines.is_empty() {
        graph.close()?;
        return Ok(None);
    }
    batch.sources = graph.standing_sources(&batch.through_at, &batch.through_id)?;
    graph.close()?;
    Ok(Some(batch))
}

pub(super) fn current(graph: &GraphRepository, root: &Path) -> CognitionResult<Option<String>> {
    let sheet = read(root).map_err(failure)?;
    let text = sheet.text.trim();
    if text.is_empty()
        || graph.standing_sources(&sheet.through_at, &sheet.through_id)? < sheet.sources
    {
        return Ok(None);
    }
    Ok(Some(format!("{HEADER}\n{text}")))
}

/// Resumes the sheet, or starts a full rebuild when an earlier source is gone.
pub fn start(graph_path: &Path, root: &Path) -> CognitionResult<Sheet> {
    let sheet = read(root).map_err(failure)?;
    let graph = GraphRepository::open_read_snapshot(graph_path)?;
    let sources = graph.standing_sources(&sheet.through_at, &sheet.through_id)?;
    graph.close()?;
    Ok(if sources < sheet.sources {
        Sheet::default()
    } else {
        sheet
    })
}

/// Full prior sheet plus new user statements, oldest first.
pub fn prompt(previous: &str, lines: &str) -> String {
    let previous = if previous.is_empty() {
        "(none)"
    } else {
        previous
    };
    format!("Current sheet:\n{previous}\n\nNew statements by the user, oldest first:\n{lines}")
}

fn failure(error: io::Error) -> CognitionError {
    CognitionError::new(CognitionCode::CognitionPromptReadFailed, error.to_string())
        .with_source(error)
}
