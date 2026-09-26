//! Bounded source-compatible skill catalog and archive import owner.

mod archive;
mod catalog;
mod contracts;
mod projection;

use std::{path::PathBuf, sync::Arc};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

pub(crate) use catalog::{SkillDefinition, SkillValidationIssue};
pub(crate) use contracts::*;

pub(crate) fn validate(catalog: &[SkillDefinition]) -> Vec<SkillValidationIssue> {
    catalog::validate(catalog)
}

const MAX_BLOCKING_SKILL_JOBS: usize = 2;

#[derive(Clone)]
pub(crate) struct NativeSkills {
    inner: Arc<Inner>,
}

struct Inner {
    resource_root: PathBuf,
    data_root: PathBuf,
    native_executable: Option<PathBuf>,
    jobs: Arc<Semaphore>,
    closed: CancellationToken,
}

impl NativeSkills {
    pub(crate) fn new(resource_root: PathBuf, data_root: PathBuf) -> Self {
        Self::with_native_executable(resource_root, data_root, None)
    }

    pub(crate) fn for_installation(
        resource_root: PathBuf,
        data_root: PathBuf,
        native_executable: PathBuf,
    ) -> Self {
        Self::with_native_executable(resource_root, data_root, Some(native_executable))
    }

    fn with_native_executable(
        resource_root: PathBuf,
        data_root: PathBuf,
        native_executable: Option<PathBuf>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                resource_root,
                data_root,
                native_executable,
                jobs: Arc::new(Semaphore::new(MAX_BLOCKING_SKILL_JOBS)),
                closed: CancellationToken::new(),
            }),
        }
    }

    pub(crate) async fn runtime_catalog(
        &self,
        project_id: Option<String>,
    ) -> Result<Vec<SkillDefinition>, SkillError> {
        let permit = self.permit().await?;
        let resources = self.inner.resource_root.clone();
        let data = self.inner.data_root.clone();
        let native_executable = self.inner.native_executable.clone();
        blocking(permit, move || {
            let mut skills = catalog::runtime(&resources, &data, project_id.as_deref())?;
            if let Some(executable) = native_executable.as_deref() {
                for skill in &mut skills {
                    let command = match skill.file_path.strip_prefix(resources.join("skills")) {
                        Ok(relative) if relative == std::path::Path::new("status/SKILL.md") => {
                            Some("status --json")
                        }
                        _ => None,
                    };
                    if let Some(command) = command
                        && let Some(path) = shell_quoted(executable)
                    {
                        skill.native_command = Some(format!("{path} {command}"));
                        if command == "status --json" {
                            skill.native_context_command =
                                Some(format!("{path} context status --json"));
                        }
                    }
                }
            }
            Ok(skills)
        })
        .await
    }

    pub(crate) async fn settings(
        &self,
        projects: Vec<(String, String)>,
    ) -> Result<SkillSettingsView, SkillError> {
        let permit = self.permit().await?;
        let resources = self.inner.resource_root.clone();
        let data = self.inner.data_root.clone();
        blocking(permit, move || {
            catalog::settings(&resources, &data, projects)
        })
        .await
    }

    pub(crate) async fn cli_settings(
        &self,
        project_ids: Option<Vec<String>>,
    ) -> Result<SkillSettingsView, SkillError> {
        let permit = self.permit().await?;
        let resources = self.inner.resource_root.clone();
        let data = self.inner.data_root.clone();
        blocking(permit, move || {
            catalog::cli_settings(&resources, &data, project_ids)
        })
        .await
    }

    pub(crate) async fn validate_settings(
        &self,
        project_ids: Option<Vec<String>>,
    ) -> Result<SkillValidationView, SkillError> {
        let permit = self.permit().await?;
        let resources = self.inner.resource_root.clone();
        let data = self.inner.data_root.clone();
        blocking(permit, move || {
            catalog::validation(&resources, &data, project_ids)
        })
        .await
    }

    pub(crate) async fn import(
        &self,
        archive: StagedSkillArchive,
        project_id: Option<String>,
    ) -> Result<SkillImportResult, SkillError> {
        let permit = self.permit().await?;
        let data = self.inner.data_root.clone();
        blocking(permit, move || {
            archive::import(&data, archive.name(), archive.path(), project_id.as_deref())
        })
        .await
    }

    pub(crate) async fn loaded_names(
        &self,
        sessions: Vec<(String, Option<String>, Option<String>)>,
    ) -> Result<Vec<Vec<String>>, SkillError> {
        let permit = self.permit().await?;
        let data = self.inner.data_root.clone();
        blocking(permit, move || {
            Ok(sessions
                .into_iter()
                .map(|(session, turn, legacy_session)| {
                    projection::loaded_names(&data, &session, turn.as_deref())
                        .or_else(|| {
                            legacy_session
                                .filter(|legacy| legacy != &session)
                                .and_then(|legacy| {
                                    projection::loaded_names(&data, &legacy, turn.as_deref())
                                })
                        })
                        .unwrap_or_default()
                })
                .collect())
        })
        .await
    }

    pub(crate) async fn close(&self) {
        self.inner.closed.cancel();
        let permits = self
            .inner
            .jobs
            .clone()
            .acquire_many_owned(MAX_BLOCKING_SKILL_JOBS as u32)
            .await;
        self.inner.jobs.close();
        drop(permits);
    }

    async fn permit(&self) -> Result<OwnedSemaphorePermit, SkillError> {
        if self.inner.closed.is_cancelled() {
            return Err(error("skills_closed", "Skill service is closed"));
        }
        let permit = tokio::select! {
            () = self.inner.closed.cancelled() => Err(error("skills_closed", "Skill service is closed")),
            permit = self.inner.jobs.clone().acquire_owned() => permit.map_err(|_| error("skills_closed", "Skill service is closed")),
        }?;
        if self.inner.closed.is_cancelled() {
            drop(permit);
            return Err(error("skills_closed", "Skill service is closed"));
        }
        Ok(permit)
    }
}

fn shell_quoted(path: &std::path::Path) -> Option<String> {
    let value = path.to_str()?;
    Some(format!("'{}'", value.replace('\'', "'\\''")))
}

async fn blocking<T: Send + 'static>(
    permit: OwnedSemaphorePermit,
    work: impl FnOnce() -> Result<T, SkillError> + Send + 'static,
) -> Result<T, SkillError> {
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|join| error("skills_job_failed", &join.to_string()))?
}

fn error(code: &'static str, message: &str) -> SkillError {
    SkillError {
        code,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests;
