use std::ops::{Deref, DerefMut};
use std::path::PathBuf;

use super::super::path_guard::GuardResult;

pub(crate) struct MutationContext {
    pub root: PathBuf,
    pub relative_only: bool,
    pub installation_root: Option<PathBuf>,
    pub protected_roots: Vec<PathBuf>,
}

pub(crate) struct WriteMutation {
    pub context: MutationContext,
    pub path: String,
    pub content: String,
    pub overwrite: bool,
    pub create_parents: bool,
    pub expected_sha256: Option<String>,
}

pub(crate) struct ExactEdit {
    pub index: usize,
    pub path: String,
    pub old_text: String,
    pub new_text: String,
    pub start_line: Option<usize>,
    pub expected_sha256: Option<String>,
}

pub(crate) struct EditMutation {
    pub context: MutationContext,
    pub edits: Vec<ExactEdit>,
    pub batch: bool,
}

/// Observes the commit points of one mutation lane, between the conflict
/// check and the filesystem operations it guards. Production observes
/// nothing; the points exist so concurrent external changes can be modelled
/// exactly where they matter.
pub(crate) trait CommitObserver: Send + Sync {
    /// Before a batch target is committed (`index` is its first edit index).
    fn before_target(&self, _index: usize, _target: &std::path::Path) {}
    /// After the external-change check, before the temporary file is written.
    fn before_replace(&self, _target: &std::path::Path) {}
    /// After a new file is linked into place, before its temporary is removed.
    fn after_link(&self, _temporary: &std::path::Path) {}
}

pub(crate) struct Unobserved;

impl CommitObserver for Unobserved {}

pub(crate) enum MutationCommand {
    Write(WriteMutation),
    Edit(EditMutation),
}

pub(crate) struct GuardedPath {
    pub public: String,
    pub absolute: PathBuf,
    pub real: PathBuf,
}

pub(crate) struct GuardedEdit {
    pub input: ExactEdit,
    pub path: GuardedPath,
    pub safe_path: String,
}

pub(crate) enum GuardedCommand {
    Write(WriteMutation, GuardedPath),
    Edit(EditMutation, Vec<GuardedEdit>),
}

#[derive(Clone, Debug)]
pub(crate) struct MutationFailure(Box<MutationFailureData>);

#[derive(Clone, Debug)]
pub(crate) struct MutationFailureData {
    pub path: Option<String>,
    pub error: &'static str,
    pub message: String,
    pub recovery_hint: String,
    pub before_sha256: Option<String>,
    pub expected_sha256: Option<String>,
    pub current_sha256: Option<String>,
    pub guard: Option<Box<GuardResult>>,
}

impl MutationFailure {
    pub(crate) fn from_data(data: MutationFailureData) -> Self {
        Self(Box::new(data))
    }

    pub(crate) fn into_data(self) -> MutationFailureData {
        *self.0
    }
}

impl Deref for MutationFailure {
    type Target = MutationFailureData;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for MutationFailure {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ChangedLine {
    pub kind: &'static str,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
    pub content: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ChangedFile {
    pub path: String,
    pub additions: usize,
    pub deletions: usize,
    pub lines: Vec<ChangedLine>,
    pub before_text: String,
    pub after_text: String,
    pub file_created: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct CommittedFile {
    pub path: String,
    pub created: bool,
    pub bytes: usize,
    pub before_sha256: Option<String>,
    pub after_sha256: String,
    pub cleanup_failed: bool,
    pub changed_file: Option<ChangedFile>,
}

#[derive(Clone, Debug)]
pub(crate) struct EditedFile {
    pub index: usize,
    pub edit_indexes: Vec<usize>,
    pub start_line: usize,
    pub committed: CommittedFile,
}

#[derive(Clone, Debug)]
pub(crate) struct EditFailure(Box<EditFailureData>);

#[derive(Clone, Debug)]
pub(crate) struct EditFailureData {
    pub index: usize,
    pub path: Option<String>,
    pub error: &'static str,
    pub occurrences: Option<usize>,
    pub before_sha256: Option<String>,
    pub current_sha256: Option<String>,
    pub expected_sha256: Option<String>,
    pub start_line: Option<usize>,
    pub bytes: Option<usize>,
    pub guard: Option<Box<GuardResult>>,
}

impl EditFailure {
    pub(crate) fn from_data(data: EditFailureData) -> Self {
        Self(Box::new(data))
    }
}

impl Deref for EditFailure {
    type Target = EditFailureData;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for EditFailure {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl EditFailure {
    pub(crate) fn new(index: usize, path: Option<String>, error: &'static str) -> Self {
        Self::from_data(EditFailureData {
            index,
            path,
            error,
            occurrences: None,
            before_sha256: None,
            current_sha256: None,
            expected_sha256: None,
            start_line: None,
            bytes: None,
            guard: None,
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct BatchResult {
    pub applied: Vec<EditedFile>,
    pub unchanged: Vec<(usize, String)>,
    pub preflight_failures: Vec<EditFailure>,
    pub conflicting: Vec<EditFailure>,
    pub not_attempted: Vec<(usize, Option<String>, Vec<usize>)>,
    pub error: Option<&'static str>,
}

pub(crate) enum MutationOutcome {
    Write(Result<CommittedFile, MutationFailure>),
    Single(Result<EditedFile, EditFailure>),
    Batch(BatchResult),
}
