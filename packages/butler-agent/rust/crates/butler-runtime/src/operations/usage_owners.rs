//! Shared ownership of usage scopes. Both log indexes keep their incremental folds.
use butler_turn::btcc::{SqliteSubsessionRepository, StorageError};
use parking_lot::Mutex;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

/// Internal attribution key. Public log scopes are never rewritten.
#[derive(Clone, Hash, PartialEq, Eq)]
pub enum UsageScope {
    Legacy(Arc<str>),
    Stamped {
        scope: Arc<str>,
        root: Arc<str>,
        role: Arc<str>,
    },
}
impl UsageScope {
    pub fn legacy(scope: &str) -> Self {
        Self::Legacy(Arc::from(scope))
    }
}
type Member = (UsageScope, Arc<str>);

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
    scopes: HashMap<Arc<str>, Vec<Member>>,
}
impl UsageOwners {
    /// Register each row's explicit owner independently of other rows of its scope.
    pub fn observe(&self, scope: &str, root: Option<&str>, role: Option<&str>) -> UsageScope {
        let mut state = self.state.lock();
        if let Some(root) = root {
            let role: Arc<str> = Arc::from(role.unwrap_or("main"));
            let key = UsageScope::Stamped {
                scope: Arc::from(scope),
                root: Arc::from(root),
                role: role.clone(),
            };
            let members = state.members.entry(Arc::from(root)).or_default();
            if !members.iter().any(|(member, _)| member == &key) {
                members.push((key.clone(), role.clone()));
                state.generation = state.generation.wrapping_add(1);
            }
            let scopes = state.scopes.entry(Arc::from(scope)).or_default();
            if !scopes.iter().any(|(member, _)| member == &key) {
                scopes.push((key.clone(), Arc::from(role.as_ref())));
            }
            // Session aliases remain useful even with exclusively stamped rows.
            if scope.starts_with("btcc-guided:") && !state.owner.contains_key(scope) {
                state.install(scope, root, &role);
            }
            return key;
        }
        if scope.starts_with("btcc-guided:") && !state.owner.contains_key(scope) {
            state.unknown.insert(scope.into());
        }
        UsageScope::legacy(scope)
    }
    pub fn is_chat_root(&self, root: &str) -> bool {
        self.state.lock().members.contains_key(root)
    }
    pub fn scope_root(&self, scope: &UsageScope) -> String {
        match scope {
            UsageScope::Legacy(scope) => self.root_scope(scope),
            UsageScope::Stamped { root, .. } => format!("btcc-guided:{root}"),
        }
    }
    fn recheck_self_roots(&self) {
        let mut state = self.state.lock();
        let scopes: Vec<_> = state
            .owner
            .iter()
            .filter(|(scope, (root, _))| scope.strip_prefix("btcc-guided:") == Some(root.as_ref()))
            .map(|(scope, _)| scope.to_string())
            .collect();
        state.unknown.extend(scopes);
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
    pub fn members(&self, root_scope: &str) -> Vec<Member> {
        let state = self.state.lock();
        let root = root_scope
            .strip_prefix("btcc-guided:")
            .unwrap_or(root_scope);
        let mut members = if root_scope.starts_with("btcc-guided:") {
            state.members.get(root).cloned().unwrap_or_default()
        } else {
            state.scopes.get(root_scope).cloned().unwrap_or_default()
        };
        if !members
            .iter()
            .any(|(scope, _)| *scope == UsageScope::legacy(root_scope))
        {
            members.push((UsageScope::legacy(root_scope), Arc::from("main")));
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
        if let Some((old_root, old_role)) = self.owner.get(scope) {
            if old_root.as_ref() == root && old_role.as_ref() == role {
                return;
            }
            if let Some(members) = self.members.get_mut(&old_root.clone()) {
                members.retain(|(key, _)| *key != UsageScope::legacy(scope));
            }
        }
        let scope: Arc<str> = Arc::from(scope);
        let root: Arc<str> = Arc::from(root);
        let role: Arc<str> = Arc::from(role);
        self.owner
            .insert(scope.clone(), (root.clone(), role.clone()));
        self.members
            .entry(root)
            .or_default()
            .push((UsageScope::Legacy(scope), role));
        self.generation = self.generation.wrapping_add(1);
    }
}
type Links = HashMap<String, Option<(String, Option<String>)>>;
/// Process-lifetime indexed ancestry cache, including negative lookups.
pub struct UsageLineage {
    pub owners: Arc<UsageOwners>,
    pub(crate) tool_monitor: Arc<crate::operations::UsageMonitor>,
    /// Serialize refresh, relation resolution and projection across readers.
    pub read: tokio::sync::Mutex<()>,
    repository: SqliteSubsessionRepository,
    links: tokio::sync::Mutex<Links>,
    watermark: Mutex<Option<i64>>,
    failed: std::sync::atomic::AtomicBool,
}
impl UsageLineage {
    /// One lineage owner is composed for both the monitor and session view.
    pub fn new(repository: SqliteSubsessionRepository) -> Self {
        let owners = Arc::new(UsageOwners::default());
        Self {
            tool_monitor: Arc::new(crate::operations::UsageMonitor::with_owners(owners.clone())),
            owners,
            read: tokio::sync::Mutex::new(()),
            repository,
            links: tokio::sync::Mutex::new(HashMap::new()),
            watermark: Mutex::new(None),
            failed: std::sync::atomic::AtomicBool::new(false),
        }
    }
    /// Resolve only newly observed legacy scopes, never scanning relations or logs.
    pub async fn resolve(&self) {
        use std::sync::atomic::Ordering;
        if self.try_resolve().await.is_err() {
            if !self.failed.swap(true, Ordering::Relaxed) {
                tracing::warn!(
                    "Usage lineage lookup failed; unresolved scopes will retry on a later read"
                );
            }
        } else {
            self.failed.store(false, Ordering::Relaxed);
        }
    }
    async fn try_resolve(&self) -> Result<(), StorageError> {
        let mut links = self.links.lock().await;
        let watermark = self.repository.relation_watermark().await?;
        if self.watermark.lock().as_ref() != Some(&watermark) {
            links.retain(|_, link| link.is_some());
            self.owners.recheck_self_roots();
            *self.watermark.lock() = Some(watermark);
        }
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
