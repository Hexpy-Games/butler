//! Project names registered in `butler.config.json`, which lists projects
//! either as an array or as a name-keyed object.

use indexmap::IndexMap;
use serde::Deserialize;

use crate::lenient::{Arg, Obj};

#[derive(Default, Deserialize)]
struct ProjectsConfig {
    #[serde(default)]
    projects: Arg<ProjectList>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ProjectList {
    List(Vec<Arg<Obj<ProjectEntry>>>),
    Map(IndexMap<String, Arg<Obj<ProjectEntry>>>),
}

#[derive(Default, Deserialize)]
struct ProjectEntry {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    name: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    path: Option<String>,
}

/// A configured project that has a string name.
pub(crate) struct RegisteredProject {
    /// Project name.
    pub(crate) name: String,
    /// Workspace path, when a string one is configured.
    pub(crate) path: Option<String>,
}

/// The `name` of every configured project that has a string name, in
/// configuration order; nothing for a missing or unreadable configuration.
pub(crate) fn registered_project_names(config_json: &[u8]) -> Vec<String> {
    registered_projects(config_json)
        .into_iter()
        .map(|project| project.name)
        .collect()
}

/// Every configured project that has a string name, in configuration
/// order; nothing for a missing or unreadable configuration.
pub(crate) fn registered_projects(config_json: &[u8]) -> Vec<RegisteredProject> {
    let Ok(config) = serde_json::from_slice::<serde_json::Value>(config_json) else {
        return Vec::new();
    };
    let config: ProjectsConfig = crate::lenient::view(&config);
    let entries: Vec<Arg<Obj<ProjectEntry>>> = match config.projects {
        Arg::Valid(ProjectList::List(entries)) => entries,
        Arg::Valid(ProjectList::Map(entries)) => entries.into_values().collect(),
        Arg::Missing | Arg::Null | Arg::Invalid(_) => Vec::new(),
    };
    entries
        .into_iter()
        .filter_map(|entry| match entry {
            Arg::Valid(Obj(ProjectEntry {
                name: Some(name),
                path,
            })) => Some(RegisteredProject { name, path }),
            _ => None,
        })
        .collect()
}
