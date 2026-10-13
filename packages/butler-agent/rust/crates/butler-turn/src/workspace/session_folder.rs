//! The session's own working folder: the agent moves it (into a worktree it
//! made, a subfolder, or an approved folder) and the session binding keeps it
//! across turns and restarts. The marker records whether the user consented
//! to the folder, which decides whether it counts as the project folder.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use butler_platform::secure_fs::{canonicalize, path_is_within};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::path_guard::{lexical_absolute, looks_sensitive, realpath_or_nearest};
use super::session_recovery::path::parse_worktrees;
use super::{
    CommandStep, Commands, RebindWorkspaceInput, RebindWorkspaceResult, SessionBindingStore,
    StoredSessionBinding, StructuredCommandInput, WorkspaceFiles, WorkspaceResult,
};

/// The binding metadata key of the marker.
pub const SESSION_FOLDER_KEY: &str = "sessionFolder";
const SCHEMA: &str = "butler.session-folder.v1";

/// How a target folder relates to the current working folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FolderRelation {
    Current,
    Subfolder,
    /// A worktree (or a folder in one) of the current folder's repository.
    SameRepository,
    Outside,
}

impl FolderRelation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Subfolder => "subfolder",
            Self::SameRepository => "same_repository",
            Self::Outside => "outside",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "current" => Self::Current,
            "subfolder" => Self::Subfolder,
            "same_repository" => Self::SameRepository,
            "outside" => Self::Outside,
            _ => return None,
        })
    }

    /// Whether the switch stays within the current folder or its repository.
    pub fn contained(self) -> bool {
        !matches!(self, Self::Outside)
    }
}

/// An existing folder a session may move to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderInspection {
    /// Canonical absolute path.
    pub path: String,
    pub relation: FolderRelation,
}

/// Why a folder can never become the working folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FolderRefusal {
    Missing,
    NotDirectory,
    Protected,
}

impl FolderRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::Missing => "folder_not_found",
            Self::NotDirectory => "folder_not_directory",
            Self::Protected => "folder_protected",
        }
    }
}

/// Folders a working folder may never be inside.
pub struct FolderRoots<'a> {
    pub butler_data: &'a Path,
    pub protected_roots: &'a [PathBuf],
    pub installation_root: Option<&'a Path>,
}

/// The stored marker of a moved working folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionFolderMarker {
    pub path: String,
    /// The folder before the first move; used when `path` disappears.
    pub origin_path: String,
    /// The user consented to `path` (approved it, or it stays within a
    /// consented folder or its repository).
    pub consented: bool,
    pub relation: FolderRelation,
    pub switched_at: String,
}

/// The marker of `metadata`, if it is well-formed.
// Passthrough: parse boundary validating untyped JSON into typed values.
pub fn read_session_folder(metadata: Option<&Map<String, Value>>) -> Option<SessionFolderMarker> {
    let marker = metadata?.get(SESSION_FOLDER_KEY)?.as_object()?;
    let text = |key: &str| marker.get(key).and_then(Value::as_str).map(str::to_owned);
    if marker.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return None;
    }
    let path = text("path").filter(|path| Path::new(path).is_absolute())?;
    let origin_path = text("originPath").filter(|path| Path::new(path).is_absolute())?;
    Some(SessionFolderMarker {
        path,
        origin_path,
        consented: marker.get("consented").and_then(Value::as_bool)?,
        relation: FolderRelation::parse(&text("relation")?)?,
        switched_at: text("switchedAt")?,
    })
}

/// The marker of a binding that still points at its moved folder.
pub fn active_session_folder(binding: &StoredSessionBinding) -> Option<SessionFolderMarker> {
    read_session_folder(binding.metadata.as_ref())
        .filter(|marker| marker.path == binding.workspace_path)
}

/// One move of a session's working folder.
pub struct SwitchSessionFolder {
    pub session_id: String,
    pub path: String,
    pub relation: FolderRelation,
    pub consented: bool,
}

/// The result of a move.
#[derive(Clone, Debug, PartialEq)]
pub enum SwitchSessionFolderResult {
    Switched {
        path: String,
        previous_path: String,
    },
    /// The session already works in `path`.
    Unchanged { path: String },
    /// The session has no binding.
    Missing,
    /// The binding changed concurrently.
    Changed,
}

/// Moves session working folders; reads Git only to relate folders.
#[derive(Clone)]
pub struct SessionFolders {
    bindings: SessionBindingStore,
    commands: Commands,
    files: WorkspaceFiles,
    host_environment: Arc<HashMap<String, String>>,
}

impl SessionFolders {
    pub fn new(
        bindings: SessionBindingStore,
        commands: Commands,
        files: WorkspaceFiles,
        host_environment: Arc<HashMap<String, String>>,
    ) -> Self {
        Self {
            bindings,
            commands,
            files,
            host_environment,
        }
    }

    /// Resolves `target` (absolute, or relative to `current`) and relates it
    /// to `current`.
    pub async fn inspect(
        &self,
        current: &Path,
        target: &str,
        roots: FolderRoots<'_>,
        abort: CancellationToken,
    ) -> WorkspaceResult<Result<FolderInspection, FolderRefusal>> {
        let requested = current.join(target);
        let current = current.to_path_buf();
        let resolved = self
            .files
            .run(move || resolve(&current, &requested))
            .await?;
        let (current, path, relation) = match resolved {
            Ok(resolved) => resolved,
            Err(refusal) => return Ok(Err(refusal)),
        };
        let in_data = path_is_within(&path, &realpath_or_nearest(roots.butler_data));
        let in_worktree = if relation.is_none() || in_data {
            self.worktree_contains(&current, &path, abort).await?
        } else {
            false
        };
        let relation = match relation {
            Some(relation) => relation,
            None if in_worktree => FolderRelation::SameRepository,
            None => FolderRelation::Outside,
        };
        Ok(if protected(&path, in_data && !in_worktree, &roots) {
            Err(FolderRefusal::Protected)
        } else {
            Ok(FolderInspection {
                path: path.to_string_lossy().into_owned(),
                relation,
            })
        })
    }

    /// The canonical worktree paths of the repository `cwd` is in; `None`
    /// when `cwd` is not in a repository or Git is unavailable.
    pub async fn worktrees(
        &self,
        cwd: &Path,
        abort: CancellationToken,
    ) -> WorkspaceResult<Option<Vec<PathBuf>>> {
        let output = self
            .commands
            .submit_structured(StructuredCommandInput {
                steps: vec![CommandStep {
                    executable: "git".into(),
                    arguments: ["worktree", "list", "--porcelain", "-z"]
                        .map(str::to_owned)
                        .to_vec(),
                }],
                cwd: Some(cwd.to_path_buf()),
                environment: HashMap::new(),
                host_environment: (*self.host_environment).clone(),
                inherit_environment: true,
                stdin: String::new(),
                timeout_ms: Some(30_000.0),
                abort,
                legacy: None,
            })?
            .await
            .ok();
        let Some(output) = output.filter(|output| output.exit_code == Some(0)) else {
            return Ok(None);
        };
        let paths = self
            .files
            .run(move || {
                parse_worktrees(&output.stdout).ok().map(|entries| {
                    entries
                        .into_iter()
                        .map(|entry| canonicalize(&entry.path).unwrap_or(entry.path))
                        .collect()
                })
            })
            .await?;
        Ok(paths)
    }

    async fn worktree_contains(
        &self,
        current: &Path,
        target: &Path,
        abort: CancellationToken,
    ) -> WorkspaceResult<bool> {
        Ok(self
            .worktrees(current, abort)
            .await?
            .is_some_and(|paths| paths.iter().any(|root| path_is_within(target, root))))
    }

    /// Points the session at `input.path` and records the marker.
    pub async fn switch(
        &self,
        input: SwitchSessionFolder,
    ) -> WorkspaceResult<SwitchSessionFolderResult> {
        let Some(binding) = self.bindings.get_by_session_id(&input.session_id).await? else {
            return Ok(SwitchSessionFolderResult::Missing);
        };
        let previous = read_session_folder(binding.metadata.as_ref());
        if binding.workspace_path == input.path
            && previous.as_ref().is_some_and(|marker| {
                marker.path == input.path && marker.consented == input.consented
            })
        {
            return Ok(SwitchSessionFolderResult::Unchanged { path: input.path });
        }
        let clock = self.bindings.clock();
        let now = clock.iso_from_epoch_millis(clock.now_epoch_millis())?;
        let origin = previous
            .filter(|marker| marker.path == binding.workspace_path)
            .map_or_else(|| binding.workspace_path.clone(), |marker| marker.origin_path);
        let mut metadata = binding.metadata.clone().unwrap_or_default();
        metadata.insert(
            SESSION_FOLDER_KEY.into(),
            json!({
                "schema": SCHEMA,
                "path": input.path,
                "originPath": origin,
                "consented": input.consented,
                "relation": input.relation.as_str(),
                "switchedAt": now,
            }),
        );
        let previous_path = binding.workspace_path.clone();
        let result = self
            .bindings
            .rebind_workspace(RebindWorkspaceInput {
                session_id: input.session_id,
                expected_updated_at: binding.updated_at,
                workspace_path: input.path.clone(),
                metadata,
                updated_at: Some(now),
            })
            .await?;
        Ok(match result {
            RebindWorkspaceResult::Applied(_) => SwitchSessionFolderResult::Switched {
                path: input.path,
                previous_path,
            },
            RebindWorkspaceResult::Changed(_) => SwitchSessionFolderResult::Changed,
            RebindWorkspaceResult::Missing => SwitchSessionFolderResult::Missing,
        })
    }
}

type Resolved = (PathBuf, PathBuf, Option<FolderRelation>);

/// The canonical current folder and target, and their relation when it
/// needs no Git.
fn resolve(current: &Path, requested: &Path) -> Result<Resolved, FolderRefusal> {
    let absolute = lexical_absolute(requested).map_err(|_| FolderRefusal::Missing)?;
    let path = canonicalize(&absolute).map_err(|_| FolderRefusal::Missing)?;
    if !path.metadata().is_ok_and(|metadata| metadata.is_dir()) {
        return Err(FolderRefusal::NotDirectory);
    }
    let current = canonicalize(current).unwrap_or_else(|_| current.to_path_buf());
    let relation = if path == current {
        Some(FolderRelation::Current)
    } else if path_is_within(&path, &current) {
        Some(FolderRelation::Subfolder)
    } else {
        None
    };
    Ok((current, path, relation))
}

/// Credentials, private metadata, Butler's installation and its ledgers are
/// never a working folder. Butler's data is not either, except a worktree of
/// the current repository (session worktrees live there): `in_data` is set
/// for any other folder in it.
fn protected(path: &Path, in_data: bool, roots: &FolderRoots<'_>) -> bool {
    let within = |root: &Path| path_is_within(path, &realpath_or_nearest(root));
    in_data
        || looks_sensitive(&path.to_string_lossy())
        || roots.installation_root.is_some_and(within)
        || roots.protected_roots.iter().any(|root| within(root))
}
