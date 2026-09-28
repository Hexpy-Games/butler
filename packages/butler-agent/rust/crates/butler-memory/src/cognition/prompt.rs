//! Bounded, tracked source reads for admission-time Cognition prompt facts.

mod feedback;
mod memory;
mod owner;

use std::path::{Path, PathBuf};

use crate::cognition::{CognitionPathEnvironment, CognitionResult};

use owner::PromptReadOwner;

fn read_utf8(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => String::from_utf8_lossy(&error.into_bytes()).into_owned(),
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopedPromptFeedback {
    pub scope_kind: String,
    pub content: String,
}

/// Whether a project capsule exists for the prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CapsulePresence {
    /// No project was given.
    Skipped,
    /// The capsule exists.
    Present,
    /// The project has no capsule yet.
    Missing,
}

/// Reads the memory context prompts are built from.
pub struct CognitionPromptReader {
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    owner: PromptReadOwner,
}

impl CognitionPromptReader {
    /// A reader over `data_root`.
    pub fn new(
        data_root: PathBuf,
        environment: CognitionPathEnvironment,
        max_blocking_reads: usize,
    ) -> Self {
        Self {
            data_root,
            environment,
            owner: PromptReadOwner::new(max_blocking_reads),
        }
    }

    /// Feedback that applies to the session and project.
    pub async fn scoped_feedback(
        &self,
        session: String,
        project: Option<String>,
    ) -> CognitionResult<Vec<ScopedPromptFeedback>> {
        let root = self.environment.cognition_root(&self.data_root);
        self.owner
            .run(move || feedback::read(&root, &session, project.as_deref()))
            .await
    }

    /// The active generation's hot cache for the project, when readable.
    pub async fn generation_hot_cache(
        &self,
        project: Option<String>,
    ) -> CognitionResult<Option<String>> {
        let root = self.data_root.clone();
        let environment = self.environment.clone();
        self.owner
            .run(move || {
                Ok(memory::generation_hot_cache(
                    &root,
                    &environment,
                    project.as_deref(),
                ))
            })
            .await
    }

    /// The continuity notes of `session`.
    pub async fn session_continuity(&self, session: String) -> CognitionResult<Option<String>> {
        let root = self.environment.memory_root(&self.data_root);
        self.owner
            .run(move || memory::continuity(&root, &session))
            .await
    }

    /// The project's memory capsule.
    pub async fn project_capsule(
        &self,
        project: Option<String>,
    ) -> CognitionResult<Option<String>> {
        let root = self.environment.memory_root(&self.data_root);
        self.owner
            .run(move || memory::project(&root, project.as_deref()))
            .await
    }

    /// Whether the project's memory capsule exists.
    pub async fn project_capsule_status(
        &self,
        project: Option<String>,
    ) -> CognitionResult<CapsulePresence> {
        let root = self.environment.memory_root(&self.data_root);
        self.owner
            .run(move || memory::status(&root, project.as_deref()))
            .await
    }

    /// Stops admitting reads and waits for running ones.
    pub async fn close(&self) {
        self.owner.close().await;
    }
}
