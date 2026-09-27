//! A test constructor for capabilities with an empty skills catalog.

use std::sync::Arc;

use butler_turn::workspace::{WorkspaceFiles, WorkspaceMutations};

use super::Capabilities;
use crate::skills::Skills;

impl Capabilities {
    pub fn new(files: Arc<WorkspaceFiles>, mutations: Arc<WorkspaceMutations>) -> Self {
        let root = std::env::temp_dir().join("butler-native-empty-skills");
        Self::with_skills(files, mutations, Arc::new(Skills::new(root.clone(), root)))
    }
}
