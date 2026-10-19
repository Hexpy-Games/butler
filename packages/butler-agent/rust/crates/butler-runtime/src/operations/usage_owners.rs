//! Shared ownership of usage scopes. Both log indexes keep their incremental folds.
use butler_turn::btcc::{SqliteSubsessionRepository, StorageError};
use parking_lot::Mutex;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

type Member = (Arc<str>, Arc<str>);

/// Scope -> root/role and the reverse membership list, shared by both API readers.
#[derive(Default)]
pub struct UsageOwners {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    owner: HashMap<Arc<str>, (Arc<str>, Arc<str>)>,
    members: HashMap<Arc<str>, Vec<Member>>,
    unknown: HashSet<String>,
    generation: u64,
}
impl UsageOwners {
    /// Record the first stamped owner, or queue an unseen guided scope for lineage.
    pub fn observe(&self, scope: &str, root: Option<&str>, role: Option<&str>) {
        let mut state = self.state.lock();
        if state.owner.contains_key(scope) {
            return;
        }
        if let Some(root) = root {
            state.install(scope, root, role.unwrap_or("main"));
        } else if scope.starts_with("btcc-guided:") {
            state.unknown.insert(scope.into());
        }
    }
    /// Changes invalidate windowed session totals without rescanning log rows.
    pub fn generation(&self) -> u64 {
        self.state.lock().generation
    }
    /// Canonical root scope; non-chat legacy scopes retain their existing identity.
    pub fn root_scope(&self, scope: &str) -> String {
        self.state.lock().owner.get(scope).map_or_else(
            || scope.to_owned(),
            |(root, _)| format!("btcc-guided:{root}"),
        )
    }
    /// Only the selected root's member scopes, including its own guided scope.
    pub fn members(&self, root_scope: &str) -> Vec<(Arc<str>, Arc<str>)> {
        let state = self.state.lock();
        let root = root_scope
            .strip_prefix("btcc-guided:")
            .unwrap_or(root_scope);
        let mut members = state.members.get(root).cloned().unwrap_or_default();
        if !members
            .iter()
            .any(|(scope, _)| scope.as_ref() == root_scope)
        {
            members.push((Arc::from(root_scope), Arc::from("main")));
        }
        members
    }
    fn unknown(&self) -> Vec<String> {
        self.state.lock().unknown.iter().cloned().collect()
    }
    fn install(&self, scope: &str, root: &str, role: &str) {
        self.state.lock().install(scope, root, role);
    }
}
impl State {
    fn install(&mut self, scope: &str, root: &str, role: &str) {
        self.unknown.remove(scope);
        if self.owner.contains_key(scope) {
            return;
        }
        let scope: Arc<str> = Arc::from(scope);
        let root: Arc<str> = Arc::from(root);
        let role: Arc<str> = Arc::from(role);
        self.owner
            .insert(scope.clone(), (root.clone(), role.clone()));
        self.members.entry(root).or_default().push((scope, role));
        self.generation = self.generation.wrapping_add(1);
    }
}
type Links = HashMap<String, Option<(String, Option<String>)>>;
/// Process-lifetime indexed ancestry cache, including negative lookups.
pub struct UsageLineage {
    pub owners: Arc<UsageOwners>,
    repository: SqliteSubsessionRepository,
    links: tokio::sync::Mutex<Links>,
}
impl UsageLineage {
    /// One lineage owner is composed for both the monitor and session view.
    pub fn new(repository: SqliteSubsessionRepository) -> Self {
        Self {
            owners: Arc::default(),
            repository,
            links: tokio::sync::Mutex::new(HashMap::new()),
        }
    }
    /// Resolve only newly observed legacy scopes, never scanning relations or logs.
    pub async fn resolve(&self) -> Result<(), StorageError> {
        let mut links = self.links.lock().await;
        let unknown = self.owners.unknown();
        let children = unknown
            .iter()
            .filter_map(|s| s.strip_prefix("btcc-guided:").map(str::to_owned))
            .collect();
        self.load_ancestors(children, &mut links).await?;
        let mut roots = HashMap::new();
        for scope in unknown {
            let id = scope.strip_prefix("btcc-guided:").unwrap_or(&scope);
            let root = legacy_root(id, &links, &mut roots);
            let role = match links.get(id) {
                Some(Some((_, role))) => role.as_deref().unwrap_or("delegated"),
                _ => "main",
            };
            self.owners.install(&scope, &root, role);
        }
        Ok(())
    }
    async fn load_ancestors(
        &self,
        children: Vec<String>,
        links: &mut Links,
    ) -> Result<(), StorageError> {
        let mut pending = children;
        let mut visited = HashSet::new();
        while !pending.is_empty() {
            let batch: Vec<_> = pending
                .drain(..)
                .filter(|id| visited.insert(id.clone()))
                .collect();
            if batch.is_empty() {
                break;
            }
            let missing: Vec<_> = batch
                .iter()
                .filter(|id| !links.contains_key(*id))
                .cloned()
                .collect();
            if !missing.is_empty() {
                let found = self.repository.parent_links(missing.clone()).await?;
                for id in missing {
                    links.insert(id, None);
                }
                for (child, parent, role) in found {
                    links.insert(child, Some((parent, role)));
                }
            }
            for id in batch {
                if let Some(Some((parent, _))) = links.get(&id) {
                    pending.push(parent.clone());
                }
            }
        }
        Ok(())
    }
}
fn legacy_root(id: &str, links: &Links, roots: &mut HashMap<String, String>) -> String {
    let mut path = Vec::new();
    let mut seen = HashSet::new();
    let mut current = id;
    let root = loop {
        if let Some(root) = roots.get(current) {
            break root.clone();
        }
        if !seen.insert(current) {
            return id.into();
        }
        path.push(current);
        match links.get(current) {
            Some(Some((parent, _))) => current = parent,
            _ => break current.to_owned(),
        }
    };
    for node in path {
        roots.insert(node.into(), root.clone());
    }
    root
}
