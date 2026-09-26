use std::path::PathBuf;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SkillSummary {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) applicability: String,
    pub(crate) source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) project_id: Option<String>,
    pub(crate) file_path: String,
    pub(crate) user_invocable: bool,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SkillProjectView {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) skills: Vec<SkillSummary>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SkillSettingsView {
    pub(crate) storage_root: String,
    pub(crate) core: Vec<SkillSummary>,
    pub(crate) user: Vec<SkillSummary>,
    pub(crate) projects: Vec<SkillProjectView>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SkillImportResult {
    pub(crate) imported: Vec<SkillSummary>,
    pub(crate) skipped: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SkillValidationIssueView {
    #[serde(rename = "filePath")]
    pub(crate) file_path: String,
    pub(crate) message: String,
    pub(crate) source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) project_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SkillValidationCounts {
    pub(crate) core: usize,
    pub(crate) user: usize,
    pub(crate) project: usize,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SkillValidationView {
    pub(crate) ok: bool,
    pub(crate) counts: SkillValidationCounts,
    pub(crate) issues: Vec<SkillValidationIssueView>,
}

pub(crate) struct StagedSkillArchive {
    name: String,
    path: PathBuf,
    cleanup_root: PathBuf,
}

impl StagedSkillArchive {
    pub(crate) fn new(name: String, cleanup_root: PathBuf) -> Self {
        Self {
            name,
            path: cleanup_root.join("archive.zip"),
            cleanup_root,
        }
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for StagedSkillArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.cleanup_root);
    }
}

#[derive(Debug)]
pub(crate) struct SkillError {
    pub code: &'static str,
    pub message: String,
}
