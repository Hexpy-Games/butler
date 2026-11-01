//! The user's answers about project folders. They live under `auth/` in the data
//! folder, a credential root, where neither a project folder nor a model tool can
//! write. An answer covers one folder: a replaced or renamed one asks again, and a
//! store that cannot be read holds no answers, so it asks again too.
use super::Hooks;
use butler_core::hooks::{ProjectHookAnswer, ProjectHookRequest};
use butler_platform::secure_fs;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    path::Path,
    sync::Arc,
};

const STORE: &str = "auth/project-hook-trust.json";

/// The answer about one project folder.
#[derive(Deserialize, Serialize)]
struct Answer {
    identity: String,
    trusted: bool,
}

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Store {
    /// By resolved project path.
    projects: BTreeMap<String, Answer>,
}

impl Store {
    /// The answer for exactly this folder.
    pub(super) fn answer(&self, path: &str, identity: &str) -> Option<bool> {
        self.projects
            .get(path)
            .filter(|answer| answer.identity == identity)
            .map(|answer| answer.trusted)
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

/// Remembers the answer about the folder on this card.
pub(super) async fn decide(
    hooks: &Arc<Hooks>,
    request: ProjectHookRequest,
    trusted: bool,
) -> Result<(), String> {
    let _writer = hooks.trust_writer.lock().await;
    let data = hooks.data.clone();
    tokio::task::spawn_blocking(move || {
        let mut store = read(&data);
        store.projects.insert(
            request.project_path,
            Answer {
                identity: request.project_identity,
                trusted,
            },
        );
        write(&data, &store)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

/// Every saved answer, by path.
pub(super) async fn list(hooks: &Arc<Hooks>) -> Result<Vec<ProjectHookAnswer>, String> {
    let data = hooks.data.clone();
    let store = tokio::task::spawn_blocking(move || read(&data))
        .await
        .map_err(|error| error.to_string())?;
    Ok(store
        .projects
        .into_iter()
        .map(|(path, answer)| ProjectHookAnswer {
            path,
            run: answer.trusted,
        })
        .collect())
}

/// Forgets the answer about the folder at `path`; there being none is no error.
pub(super) async fn clear(hooks: &Arc<Hooks>, path: String) -> Result<(), String> {
    let _writer = hooks.trust_writer.lock().await;
    let data = hooks.data.clone();
    tokio::task::spawn_blocking(move || {
        let mut store = read(&data);
        if store.projects.remove(&path).is_none() {
            return Ok(());
        }
        write(&data, &store)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}
