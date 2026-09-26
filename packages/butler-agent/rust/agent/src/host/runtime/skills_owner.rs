use std::sync::Arc;

use crate::{
    btcc::BtccError,
    capabilities::NativeCapabilities,
    skills::NativeSkills,
    workspace::{NativeWorkspaceFiles, WorkspaceMutations},
};

use super::{NativeGuidedCatalog, NativeRuntimePaths};

type SkillsOwner = (
    Arc<NativeSkills>,
    Arc<NativeCapabilities>,
    Arc<NativeGuidedCatalog>,
);

pub(super) fn open(
    paths: &NativeRuntimePaths,
    files: &NativeWorkspaceFiles,
    mutations: &WorkspaceMutations,
) -> Result<SkillsOwner, BtccError> {
    let skills = Arc::new(NativeSkills::for_installation(
        paths.resource_root.clone(),
        paths.data_root.clone(),
        paths.executable_path.clone(),
    ));
    let capabilities = Arc::new(NativeCapabilities::with_skills(
        Arc::new(files.clone()),
        Arc::new(mutations.clone()),
        skills.clone(),
    ));
    let catalog = Arc::new(
        NativeGuidedCatalog::load(&capabilities)
            .map_err(|e| BtccError::new("guided_catalog_unavailable", e.to_string()))?,
    );
    Ok((skills, capabilities, catalog))
}
