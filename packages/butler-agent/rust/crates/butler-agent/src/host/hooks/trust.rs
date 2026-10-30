//! The user's answers about project hooks. They live under `auth/` in the data
//! folder, a credential root, where neither a project folder nor a model tool can
//! write. An answer covers one exact content of one exact folder: anything else
//! asks again. A store that cannot be read holds no answers, so it asks again too.
use super::Hooks;
use butler_core::hooks::{ProjectHookChange, ProjectHookLine, ProjectHookRequest};
use butler_platform::secure_fs;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    path::Path,
    sync::Arc,
};

const STORE: &str = "auth/project-hook-trust.json";

/// The answer about one project folder's hook file.
#[derive(Clone, Deserialize, Serialize)]
struct Answer {
    identity: String,
    hash: String,
    allowed: bool,
    /// The hooks of the content last allowed, which later cards mark changes from.
    last_allowed: Vec<ProjectHookLine>,
}

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Store {
    /// By resolved project path.
    projects: BTreeMap<String, Answer>,
}

impl Store {
    /// The answer for exactly this content, in this folder.
    pub(super) fn answer(&self, request: &ProjectHookRequest) -> Option<bool> {
        self.projects
            .get(&request.project_path)
            .filter(|answer| answer.hash == request.content_hash)
            .map(|answer| answer.allowed)
    }

    /// What the user allowed last in this same folder; a replaced folder has nothing.
    pub(super) fn last_allowed(&self, path: &str, identity: &str) -> &[ProjectHookLine] {
        self.projects
            .get(path)
            .filter(|answer| answer.identity == identity)
            .map_or(&[], |answer| answer.last_allowed.as_slice())
    }
}

pub(super) fn read(data: &Path) -> Store {
    let read = || -> io::Result<Store> {
        let mut text = String::new();
        secure_fs::open_read_no_follow(&data.join(STORE))?.read_to_string(&mut text)?;
        serde_json::from_str(&text).map_err(io::Error::other)
    };
    match read() {
        Ok(store) => store,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Store::default(),
        Err(error) => {
            tracing::warn!(event = "project_hook_trust_unreadable", error = %error);
            Store::default()
        }
    }
}

fn write(data: &Path, store: &Store) -> io::Result<()> {
    let path = data.join(STORE);
    let bytes = serde_json::to_vec_pretty(store).map_err(io::Error::other)?;
    crate::host::service::data_reset::unless_resetting(data, || {
        if let Some(parent) = path.parent() {
            secure_fs::create_private_dir_all(parent)?;
        }
        secure_fs::replace_private(&path, |file| file.write_all(&bytes), |error| error)
    })
}

/// Remembers the answer for the content on this card; the store keeps one per folder.
pub(super) async fn decide(
    hooks: &Arc<Hooks>,
    request: ProjectHookRequest,
    allowed: bool,
) -> Result<(), String> {
    let _writer = hooks.trust_writer.lock().await;
    let data = hooks.data.clone();
    tokio::task::spawn_blocking(move || {
        let mut store = read(&data);
        let last_allowed = if allowed {
            request
                .hooks
                .iter()
                .filter(|hook| hook.change != Some(ProjectHookChange::Removed))
                .map(|hook| ProjectHookLine {
                    change: None,
                    ..hook.clone()
                })
                .collect()
        } else {
            store
                .last_allowed(&request.project_path, &request.project_identity)
                .to_vec()
        };
        store.projects.insert(
            request.project_path,
            Answer {
                identity: request.project_identity,
                hash: request.content_hash,
                allowed,
                last_allowed,
            },
        );
        write(&data, &store)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}
