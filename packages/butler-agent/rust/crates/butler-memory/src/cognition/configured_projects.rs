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
}

/// The `name` of every configured project that has a string name, in
/// configuration order; nothing for a missing or unreadable configuration.
pub(crate) fn registered_project_names(config_json: &[u8]) -> Vec<String> {
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
            Arg::Valid(Obj(project)) => project.name,
            _ => None,
        })
        .collect()
}
