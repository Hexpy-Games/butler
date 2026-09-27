use std::path::PathBuf;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub(crate) applicability: String,
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub file_path: String,
    pub(crate) user_invocable: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct SkillProjectView {
    pub id: String,
    pub(crate) display_name: String,
    pub skills: Vec<SkillSummary>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SkillSettingsView {
    pub(crate) storage_root: String,
    pub core: Vec<SkillSummary>,
    pub user: Vec<SkillSummary>,
    pub projects: Vec<SkillProjectView>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SkillImportResult {
    pub imported: Vec<SkillSummary>,
    pub(crate) skipped: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SkillValidationIssueView {
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub message: String,
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SkillValidationCounts {
    pub core: usize,
    pub user: usize,
    pub project: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct SkillValidationView {
    pub ok: bool,
    pub counts: SkillValidationCounts,
    pub issues: Vec<SkillValidationIssueView>,
}

pub struct StagedSkillArchive {
    name: String,
    path: PathBuf,
    cleanup_root: PathBuf,
}

impl StagedSkillArchive {
    pub fn new(name: String, cleanup_root: PathBuf) -> Self {
        Self {
            name,
            path: cleanup_root.join("archive.zip"),
            cleanup_root,
        }
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for StagedSkillArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.cleanup_root);
    }
}

/// Failures of the native skill catalog and archive import.
///
/// `Display` is the user-facing message; `code()` the CLI wire code.
#[derive(Debug, thiserror::Error)]
pub enum SkillError {
    /// The skill service is closing, so no new job is admitted.
    #[error("Skill service is closed")]
    Closed,
    /// The blocking skill job panicked or was cancelled.
    #[error("{0}")]
    JobFailed(#[source] tokio::task::JoinError),
    /// A filesystem operation on the skill catalog or staging area failed.
    #[error("{0}")]
    Io(#[source] std::io::Error),
    /// The archive is not a readable zip file.
    #[error("{0}")]
    ArchiveInvalid(#[source] zip::result::ZipError),
    /// The archive contains an entry that escapes its root.
    #[error("Skill archive contains an unsafe path")]
    ArchivePathInvalid,
}

impl SkillError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Closed => "skills_closed",
            Self::JobFailed(_) => "skills_job_failed",
            Self::Io(_) => "skills_io_failed",
            Self::ArchiveInvalid(_) => "skill_archive_invalid",
            Self::ArchivePathInvalid => "skill_archive_path_invalid",
        }
    }

    /// The user-facing message; identical to `Display`.
    pub fn message(&self) -> String {
        self.to_string()
    }
}
