//! Model-kept pages of a generation: the user's standing-fact sheet and one
//! page per project. The memory model folds new statements into a page.
use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{CognitionCode, CognitionError, CognitionResult, graph::GraphRepository};

/// Hard cap on page text in UTF-8 bytes; the writer is asked to stay under 3,000.
pub const MAX_BYTES: usize = 4 * 1024;
const BATCH_BYTES: usize = 12 * 1024;
const BATCH_ROWS: usize = 400;
const VERSION: u8 = 3;
/// Oldest marker version whose page may still be shown while it is rebuilt.
const SERVED_FROM: u8 = 2;
const PREFIX: &str = "<!-- butler-standing ";

/// Provenance text injected above the sheet.
const USER_HEADER: &str = "What Butler knows about the user, kept by Butler from earlier chats. It can be out of date; check with the user or recall_memory before relying on it for anything that matters. Use it to understand what the user refers to; do not bring it up unprompted.";
/// Stable instructions for maintaining the sheet.
const USER_INSTRUCTIONS: &str = "You keep a short fact sheet about one person, the user of a personal assistant, so the assistant always knows the lasting facts of their life without looking them up. You receive the current sheet with its size in bytes, and new statements the user made in chats, oldest first, each with its date. Return only the full updated sheet, in the user's main language, as Markdown bullet lines under a few headings of your choice.
Keep what will probably still be true and useful months from now: who the user is, where they live and work, the people and animals in their life and what each name refers to (kind, species, sex, relation, dates), what they own or run, their ongoing projects, hobbies and routines, and lasting preferences.
Write one fact per line as a short phrase, at most about 60 Korean, Chinese or Japanese characters or 120 English letters: name the thing and say what it is, without background, reasons or story. For example: \"Mango: female tabby cat, adopted March 2024\". When several names plainly refer to the same thing, put them on one line. A project gets one line that says what it is.
Leave out:
- one-off events and passing states: a meal, an errand, a symptom, a single question, a price the user checked, a recipe or product they were curious about once;
- how the assistant or its apps are set up or should behave: instructions to the assistant, settings, model choices, feature switches;
- software work details: file and folder paths, repository and branch names, tasks in progress;
- secrets: passwords, keys, account numbers, ID numbers;
- health, medical and mental-health details, money troubles, legal disputes and similar private matters, unless the user explicitly asked for that to be remembered.
Carry every line of the current sheet forward unchanged unless a new statement corrects it or space runs out. A later statement overrides an earlier one. When something ended (a pet died, a plan was dropped, the user moved), keep one line that says so with its date instead of deleting it. Record only what the statements say; never guess or generalize. If the new statements add nothing lasting, return the current sheet unchanged.
Keep the sheet under 3,000 UTF-8 bytes. A Korean, Chinese or Japanese character is 3 bytes, so that is about 1,000 such characters or 3,000 English letters. When a new fact would take the sheet past that, first shorten wordy lines, then drop the least lasting and least useful lines.";
const PROJECT_HEADER: &str = "What Butler keeps about this project from earlier chats in it. It can be out of date; check the workspace or recall_memory before relying on it for anything that matters.";
const PROJECT_INSTRUCTIONS: &str = "You keep a short page about one project that the user of a personal assistant works on with it, so the assistant starts every chat in this project knowing where things stand. You receive today's date, the current page with its size in bytes, and new statements from this project's chats. Each statement carries its date, who said it (user or assistant) and its kind. The statements are sorted by date, but one may be older than what the page already reflects: judge what is newer by the date, never by the order. Return only the full updated page, in the user's main language, as Markdown bullet lines under five headings in this order, with the headings written in that language: what it is; decisions; lessons; current state; open questions.
What it is: one to three lines that say what the project is and what it is for.
Decisions: what the user chose or approved, or what was adopted and actually done. One decision per line, with its date. A proposal by the assistant that the user did not take up is not a decision. A promise by the assistant about what it will do next is not a decision. When a later statement reverses or replaces a decision, rewrite the line to the new decision and name the replaced choice in a few words in parentheses, so the dropped choice is not proposed again.
Lessons: what was tried and failed or worked, with the reason, when it would matter again.
Current state: what exists and works now and what is in progress, each with its date. Replace a line when the state changes. Remove a line once it is finished and no longer matters.
Open questions: choices and questions that are not settled. Remove one when it is answered. When it is unclear whether something was decided, put it here and not under decisions.
Write one item per line as a short phrase, at most about 60 Korean, Chinese or Japanese characters or 120 English letters, without background or story.
Leave out: step-by-step work logs, tool output, greetings and thanks, secrets (passwords, keys, account numbers), and facts about the user's life that are not about this project.
Carry every line of the current page forward unchanged unless a new statement changes it or space runs out. Record only what the statements say; never guess or generalize. If the new statements add nothing, return the current page unchanged.
Keep the page under 3,000 UTF-8 bytes. A Korean, Chinese or Japanese character is 3 bytes, so that is about 1,000 such characters or 3,000 English letters. When a new item would take the page past that, first shorten wordy lines, then drop finished current-state lines, then the oldest lessons. Do not drop a decision that is still in force.";

/// Which page a fold maintains.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Page {
    /// Lasting facts about the user, folded from global chats.
    User,
    /// One project's decisions, lessons, state and open questions, folded
    /// from that project's chats.
    Project(String),
}

impl Page {
    /// The shown page file below a generation root.
    pub fn path(&self, root: &Path) -> PathBuf {
        self.file(&root.join("hot"))
    }

    /// The file a first build or a rebuild writes until its first pass closes.
    fn build_path(&self, root: &Path) -> PathBuf {
        self.file(&root.join("hot/building"))
    }

    fn file(&self, directory: &Path) -> PathBuf {
        match self {
            Self::User => directory.join("standing.md"),
            Self::Project(id) => directory
                .join("projects")
                .join(format!("{}.md", file_stem(id))),
        }
    }

    /// The instructions the memory model follows for this page.
    pub fn instructions(&self) -> &'static str {
        match self {
            Self::User => USER_INSTRUCTIONS,
            Self::Project(_) => PROJECT_INSTRUCTIONS,
        }
    }

    /// The fold's name in the cycle log and in usage attribution.
    pub fn phase(&self) -> &'static str {
        match self {
            Self::User => "standing_facts",
            Self::Project(_) => "project_page",
        }
    }

    /// The project id of a project page.
    pub fn project(&self) -> Option<&str> {
        match self {
            Self::User => None,
            Self::Project(id) => Some(id),
        }
    }

    fn header(&self) -> &'static str {
        match self {
            Self::User => USER_HEADER,
            Self::Project(_) => PROJECT_HEADER,
        }
    }
}

/// A project id as a file stem: path separators and NUL become `_`.
fn file_stem(id: &str) -> String {
    id.chars()
        .map(|character| {
            if matches!(character, '/' | '\\' | '\0') {
                '_'
            } else {
                character
            }
        })
        .collect()
}

/// The pre-generation capsule file of a project, kept only so a project
/// reset can delete it.
pub(crate) fn legacy_capsule_path(memory_root: &Path, project: &str) -> PathBuf {
    memory_root
        .join("projects")
        .join(format!("{}.md", file_stem(project)))
}

/// Where a fold stands inside an open pass.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pass {
    /// Extraction time of the newest claim the pass covers.
    pub to_at: String,
    /// Id of the newest claim the pass covers.
    pub to_id: String,
    /// Conversation time, extraction time and id of the last folded claim.
    pub at: (String, String, String),
    /// Current claims of the pass folded so far.
    pub sources: u64,
}

/// Page text and its progress marker.
#[derive(Clone, Default)]
pub struct Sheet {
    /// Extraction time up to which every claim is folded.
    pub through_at: String,
    /// Id of the last claim at that time.
    pub through_id: String,
    /// Number of current source claims through the cursor.
    pub sources: u64,
    /// The open pass, when a fold stopped inside one.
    pub pass: Option<Pass>,
    /// Full Markdown returned by the memory model.
    pub text: String,
}

/// A fold's starting point.
pub struct Start {
    /// The page to continue from.
    pub sheet: Sheet,
    /// The fold writes the build file: nothing complete in this format is shown yet.
    pub building: bool,
    /// The shown page lost a source and was withdrawn; its rebuild is not deferred.
    pub lost: bool,
}

/// The next statements of a pass and the progress they lead to.
pub struct Batch {
    /// Labelled statements in conversation order. Empty when the pass only closes.
    pub lines: String,
    /// Cursor once this batch is published.
    pub through_at: String,
    /// Cursor id once this batch is published.
    pub through_id: String,
    /// Source count once this batch is published.
    pub sources: u64,
    /// The pass once this batch is published; `None` when it closes.
    pub pass: Option<Pass>,
}

#[derive(Serialize, Deserialize)]
struct Marker {
    v: u8,
    through_at: String,
    through_id: String,
    sources: u64,
    #[serde(default)]
    pass: Option<Pass>,
    model: String,
    updated_at: String,
}

/// The page in `path` and its marker version; an absent or older-than-served
/// file reads as an empty page of version 0.
fn read(path: &Path) -> io::Result<(Sheet, u8)> {
    let content = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((Sheet::default(), 0)),
        Err(error) => return Err(error),
    };
    if !content.starts_with(PREFIX) {
        return Ok((Sheet::default(), 0));
    }
    let (line, text) = content
        .split_once('\n')
        .ok_or_else(|| io::Error::other("Invalid standing marker"))?;
    let marker = line
        .strip_prefix(PREFIX)
        .and_then(|s| s.strip_suffix(" -->"))
        .ok_or_else(|| io::Error::other("Invalid standing marker"))?;
    let marker: Marker = serde_json::from_str(marker).map_err(io::Error::other)?;
    if marker.v < SERVED_FROM {
        return Ok((Sheet::default(), 0));
    }
    Ok((
        Sheet {
            through_at: marker.through_at,
            through_id: marker.through_id,
            sources: marker.sources,
            pass: marker.pass,
            text: text.to_owned(),
        },
        marker.v,
    ))
}

/// Publishes one fold step. A build goes to the build file until its first
/// pass closes; then it replaces the shown file and the build file is removed.
pub fn write(
    root: &Path,
    page: &Page,
    sheet: &Sheet,
    model: &str,
    building: bool,
) -> io::Result<()> {
    if building && sheet.pass.is_some() {
        return write_file(&page.build_path(root), sheet, model);
    }
    write_file(&page.path(root), sheet, model)?;
    if building {
        remove(&page.build_path(root))?;
    }
    Ok(())
}

/// Atomically replaces `path` with a private file in the same directory.
fn write_file(path: &Path, sheet: &Sheet, model: &str) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Invalid page path"))?;
    butler_platform::secure_fs::create_private_dir_all(parent)?;
    let marker = serde_json::to_string(&Marker {
        v: VERSION,
        through_at: sheet.through_at.clone(),
        through_id: sheet.through_id.clone(),
        sources: sheet.sources,
        pass: sheet.pass.clone(),
        model: model.into(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    })
    .map_err(io::Error::other)?;
    let body = format!("{PREFIX}{marker} -->\n{}", sheet.text);
    butler_platform::secure_fs::replace_private(path, |file| file.write_all(body.as_bytes()), |e| e)
}

/// Deletes the page's shown file and build file; missing files are fine.
pub fn discard(root: &Path, page: &Page) -> io::Result<()> {
    remove(&page.path(root))?;
    remove(&page.build_path(root))
}

fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    match path.parent() {
        Some(parent) => butler_platform::secure_fs::sync_path(parent),
        None => Ok(()),
    }
}

/// Reads the next bounded batch of the page's pass in one graph snapshot.
pub fn batch(graph_path: &Path, page: &Page, sheet: &Sheet) -> CognitionResult<Option<Batch>> {
    let graph = GraphRepository::open_read_snapshot(graph_path)?;
    let result = next_batch(&graph, page, sheet);
    graph.close()?;
    result
}

fn next_batch(
    graph: &GraphRepository,
    page: &Page,
    sheet: &Sheet,
) -> CognitionResult<Option<Batch>> {
    let mut pass = match &sheet.pass {
        Some(pass) => pass.clone(),
        None => {
            let Some((to_at, to_id)) =
                graph.standing_newest(page, &sheet.through_at, &sheet.through_id)?
            else {
                return Ok(None);
            };
            Pass {
                to_at,
                to_id,
                ..Pass::default()
            }
        }
    };
    // One row past the batch tells whether the pass continues.
    let rows = graph.standing_rows(
        page,
        &sheet.through_at,
        &sheet.through_id,
        &pass,
        BATCH_ROWS + 1,
    )?;
    let mut lines = String::new();
    let mut taken = 0;
    for row in rows.iter().take(BATCH_ROWS) {
        let statement = row
            .statement
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let line = format!("[{}] {statement}", row.label);
        if !lines.is_empty() {
            if lines.len() + 1 + line.len() > BATCH_BYTES {
                break;
            }
            lines.push('\n');
        }
        lines.push_str(&line);
        pass.at = (row.time.clone(), row.at.clone(), row.id.clone());
        taken += 1;
    }
    if taken < rows.len() {
        pass.sources =
            graph.standing_pass_sources(page, &sheet.through_at, &sheet.through_id, &pass)?;
        return Ok(Some(Batch {
            lines,
            through_at: sheet.through_at.clone(),
            through_id: sheet.through_id.clone(),
            sources: sheet.sources,
            pass: Some(pass),
        }));
    }
    // The pass ends here: the cursor moves to the pass bound.
    let sources = graph.standing_sources(page, &pass.to_at, &pass.to_id)?;
    Ok(Some(Batch {
        lines,
        through_at: pass.to_at,
        through_id: pass.to_id,
        sources,
        pass: None,
    }))
}

/// Whether every claim the page was folded from is still a current source.
fn intact(graph: &GraphRepository, page: &Page, sheet: &Sheet) -> CognitionResult<bool> {
    if graph.standing_sources(page, &sheet.through_at, &sheet.through_id)? < sheet.sources {
        return Ok(false);
    }
    match &sheet.pass {
        Some(pass) => {
            Ok(
                graph.standing_pass_sources(page, &sheet.through_at, &sheet.through_id, pass)?
                    >= pass.sources,
            )
        }
        None => Ok(true),
    }
}

pub(super) fn current(
    graph: &GraphRepository,
    root: &Path,
    page: &Page,
) -> CognitionResult<Option<String>> {
    let (sheet, _) = read(&page.path(root)).map_err(failure)?;
    let text = sheet.text.trim();
    if text.is_empty() || !intact(graph, page, &sheet)? {
        return Ok(None);
    }
    Ok(Some(format!("{}\n{text}", page.header())))
}

/// Where the next fold of the page starts.
pub fn start(graph_path: &Path, root: &Path, page: &Page) -> CognitionResult<Start> {
    let graph = GraphRepository::open_read_snapshot(graph_path)?;
    let result = resume(&graph, root, page);
    graph.close()?;
    result
}

fn resume(graph: &GraphRepository, root: &Path, page: &Page) -> CognitionResult<Start> {
    let (shown, version) = read(&page.path(root)).map_err(failure)?;
    let mut lost = false;
    if version != 0 {
        if !intact(graph, page, &shown)? {
            // A source is gone: the page's text must not outlive it.
            remove(&page.path(root)).map_err(failure)?;
            lost = true;
        } else if version == VERSION {
            // A build file left behind by an interrupted promotion is stale.
            remove(&page.build_path(root)).map_err(failure)?;
            return Ok(Start {
                sheet: shown,
                building: false,
                lost: false,
            });
        }
    }
    // Nothing complete in this format is shown yet: continue or begin a build.
    let (build, build_version) = read(&page.build_path(root)).map_err(failure)?;
    let sheet = if build_version == VERSION && intact(graph, page, &build)? {
        build
    } else {
        remove(&page.build_path(root)).map_err(failure)?;
        Sheet::default()
    };
    Ok(Start {
        sheet,
        building: true,
        lost,
    })
}

/// The project ids that have conversation claims, most recent conversation first.
pub fn projects(graph_path: &Path) -> CognitionResult<Vec<String>> {
    let graph = GraphRepository::open_read_snapshot(graph_path)?;
    let result = graph.standing_projects();
    graph.close()?;
    result
}

/// Full prior page plus the new statements.
pub fn prompt(page: &Page, previous: &str, lines: &str, today: &str) -> String {
    let n = previous.len();
    let previous = if previous.is_empty() {
        "(none)"
    } else {
        previous
    };
    match page {
        Page::User => format!(
            "Current sheet ({n} bytes; keep it under 3,000):\n{previous}\n\nNew statements by the user, oldest first:\n{lines}"
        ),
        Page::Project(_) => format!(
            "Today is {today}.\nCurrent page ({n} bytes; keep it under 3,000):\n{previous}\n\nNew statements from this project's chats:\n{lines}"
        ),
    }
}

/// Asks the model to shorten a sheet that passed the hard cap.
pub fn shorten_prompt(text: &str) -> String {
    format!(
        "This sheet is {} bytes. Shorten it to under 3,000 UTF-8 bytes: first shorten wordy lines, then drop the least lasting lines. Return only the sheet.\n\n{text}",
        text.len()
    )
}

fn failure(error: io::Error) -> CognitionError {
    CognitionError::new(CognitionCode::CognitionPromptReadFailed, error.to_string())
        .with_source(error)
}
