use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct CapabilitySet {
    pub runs_on_this_computer: BTreeSet<Executable>,
    pub network: BTreeSet<String>,
    pub files: BTreeSet<FileScope>,
    pub agent_tools: BTreeSet<String>,
    pub hooks: BTreeSet<HookCapability>,
    pub secrets: BTreeSet<SecretField>,
    pub skills: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Executable {
    pub argv: Vec<String>,
    pub downloads_code_at_runtime: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct FileScope {
    pub path: String,
    pub access: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct SecretField {
    pub key: String,
    pub label: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct HookCapability {
    pub event: String,
    pub matcher: Vec<String>,
    pub argv: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Compatibility {
    pub component: String,
    pub status: String,
    pub reason: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Package {
    pub name: String,
    pub version: String,
    pub author: serde_json::Value,
    pub servers: BTreeMap<String, Server>,
    pub skills: BTreeMap<String, String>,
    pub hooks: Vec<butler_core::hooks::HookDefinition>,
    pub declared: CapabilitySet,
    pub compatibility: Vec<Compatibility>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Server {
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub env: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct FileRecord {
    pub path: String,
    pub mode: String,
    pub size: u64,
    pub modified: std::time::SystemTime,
    pub hash: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Inspection {
    pub staging_id: String,
    pub source: String,
    pub digest: String,
    pub package: Package,
    pub files: Vec<FileRecord>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Approval {
    pub content_digest: String,
    pub capabilities: CapabilitySet,
    pub hook_hashes: BTreeMap<String, String>,
    pub approved_at: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Installed {
    pub package: std::sync::Arc<Package>,
    pub source: String,
    pub approval: std::sync::Arc<Approval>,
    pub files: std::sync::Arc<Vec<FileRecord>>,
    pub enabled: bool,
    pub quarantine: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Registry {
    pub revision: u64,
    pub plugins: BTreeMap<String, Installed>,
}
