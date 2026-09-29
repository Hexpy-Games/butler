//! Bounded source-compatible skill catalog and archive import owner.

mod archive;
mod catalog;
mod contracts;
mod projection;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::SystemTime,
};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

pub(crate) use catalog::{SkillDefinition, SkillValidationIssue};
pub use contracts::*;

pub(crate) fn validate(catalog: &[SkillDefinition]) -> Vec<SkillValidationIssue> {
    catalog::validate(catalog)
}

const MAX_BLOCKING_SKILL_JOBS: usize = 2;

#[derive(Clone)]
pub struct Skills {
    inner: Arc<Inner>,
}

struct Inner {
    resource_root: PathBuf,
    data_root: PathBuf,
    native_executable: Option<PathBuf>,
    jobs: Arc<Semaphore>,
    closed: CancellationToken,
    catalog_cache: Mutex<CatalogCache>,
}

struct CachedCatalog {
    fingerprint: Vec<(PathBuf, Option<SystemTime>)>,
    skills: Vec<SkillDefinition>,
}

type CatalogCache = HashMap<Option<String>, CachedCatalog>;

fn lock_catalog_cache(cache: &Mutex<CatalogCache>) -> MutexGuard<'_, CatalogCache> {
    match cache.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            guard.clear();
            cache.clear_poison();
            guard
        }
    }
}

impl Skills {
    pub async fn compact_catalog(&self, project_id: Option<String>) -> Result<String, SkillError> {
        let skills = self.runtime_catalog(project_id).await?;
        let mut text = String::from("Available skills (call load_skill for instructions):\n");
        const MAX_BYTES: usize = 1_400;
        for skill in skills {
            let description = skill
                .description
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            let description: String = description.chars().take(72).collect();
            let line = format!("- {}: {description}\n", skill.name);
            if text.len() + line.len() > MAX_BYTES {
                if text.len() + "(more in list_skills)\n".len() <= MAX_BYTES {
                    text.push_str("(more in list_skills)\n");
                }
                break;
            }
            text.push_str(&line);
        }
        Ok(text)
    }
    pub fn new(resource_root: PathBuf, data_root: PathBuf) -> Self {
        Self::with_native_executable(resource_root, data_root, None)
    }

    pub fn for_installation(
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
                catalog_cache: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn runtime_catalog(
        &self,
        project_id: Option<String>,
    ) -> Result<Vec<SkillDefinition>, SkillError> {
        let permit = self.permit().await?;
        let resources = self.inner.resource_root.clone();
        let data = self.inner.data_root.clone();
        let native_executable = self.inner.native_executable.clone();
        let inner = self.inner.clone();
        blocking(permit, move || {
            let cached = lock_catalog_cache(&inner.catalog_cache)
                .get(&project_id)
                .map(|entry| (entry.fingerprint.clone(), entry.skills.clone()));
            if let Some((stamps, skills)) = cached
                && stamps == catalog::refresh_fingerprint(&stamps)?
            {
                return Ok(skills);
            }
            let fingerprint = catalog::fingerprint(&resources, &data, project_id.as_deref())?;
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
            lock_catalog_cache(&inner.catalog_cache).insert(
                project_id,
                CachedCatalog {
                    fingerprint,
                    skills: skills.clone(),
                },
            );
            Ok(skills)
        })
        .await
    }

    pub async fn settings(
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

    pub async fn cli_settings(
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

    pub async fn validate_settings(
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

    pub async fn import(
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

    pub async fn loaded_names(
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

    pub async fn close(&self) {
        self.inner.closed.cancel();
        let permits = self
            .inner
            .jobs
            .clone()
            .acquire_many_owned(u32::try_from(MAX_BLOCKING_SKILL_JOBS).unwrap_or(u32::MAX))
            .await;
        self.inner.jobs.close();
        drop(permits);
    }

    async fn permit(&self) -> Result<OwnedSemaphorePermit, SkillError> {
        if self.inner.closed.is_cancelled() {
            return Err(SkillError::Closed);
        }
        let permit = tokio::select! {
            () = self.inner.closed.cancelled() => Err(SkillError::Closed),
            permit = self.inner.jobs.clone().acquire_owned() => permit.map_err(|_closed| SkillError::Closed),
        }?;
        if self.inner.closed.is_cancelled() {
            drop(permit);
            return Err(SkillError::Closed);
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
    .map_err(SkillError::JobFailed)?
}

#[cfg(test)]
mod tests;
