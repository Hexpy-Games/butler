use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuidedCatalogTool {
    pub(super) name: String,
    pub(super) definition: Value,
    pub(super) effect_boundary: Option<String>,
    pub(super) category: Option<String>,
    #[serde(default)]
    pub(super) tags: Vec<String>,
    #[serde(default)]
    pub(super) safety_notes: Vec<String>,
    #[serde(default)]
    pub(super) durable: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuidedCatalogSnapshot {
    pub(super) tools: Vec<GuidedCatalogTool>,
    pub(super) profiles: HashMap<String, Vec<String>>,
    pub(super) worker_default: HashSet<String>,
    pub(super) worker_forbidden: HashSet<String>,
    pub(super) project_mutations: HashSet<String>,
    pub(super) project_inspection: HashSet<String>,
    pub(super) work_tracking: HashSet<String>,
    pub(super) managed_ledger_effects: HashSet<String>,
    pub(super) all_ledger_effects: HashSet<String>,
}

impl GuidedCatalogSnapshot {
    pub(crate) fn capability_tools(&self) -> impl Iterator<Item = GuidedCatalogRead<'_>> {
        self.tools.iter().map(|tool| GuidedCatalogRead {
            name: &tool.name,
            definition: &tool.definition,
            category: tool.category.as_deref(),
            tags: &tool.tags,
            safety_notes: &tool.safety_notes,
        })
    }

    pub(crate) fn native_tools(&self) -> impl Iterator<Item = GuidedCatalogRead<'_>> {
        self.tools
            .iter()
            .filter(|tool| !tool.durable)
            .map(|tool| GuidedCatalogRead {
                name: &tool.name,
                definition: &tool.definition,
                category: tool.category.as_deref(),
                tags: &tool.tags,
                safety_notes: &tool.safety_notes,
            })
    }

    pub(crate) fn native_tool(&self, name: &str) -> Option<GuidedCatalogRead<'_>> {
        self.native_tools().find(|tool| tool.name == name)
    }
    pub(crate) fn hidden_native_bridge_tool(
        &self,
        name: &str,
        enable_project_ledger_effects: bool,
    ) -> bool {
        self.work_tracking.contains(name)
            || (self.project_mutations.contains(name)
                && !(enable_project_ledger_effects && self.managed_ledger_effects.contains(name)))
    }
    /// Required profiles are checked against concrete Host executors at admission.
    pub(crate) fn profile_tool_names(&self, name: &str) -> Option<&[String]> {
        self.profiles.get(name).map(Vec::as_slice)
    }
    pub(crate) fn parse(json: &str) -> Result<Self, crate::btcc::BtccError> {
        serde_json::from_str(json).map_err(|error| {
            crate::btcc::BtccError::new("guided_catalog_invalid", error.to_string())
        })
    }
    pub(super) fn tool(&self, name: &str) -> Option<&GuidedCatalogTool> {
        self.tools.iter().find(|tool| tool.name == name)
    }
    pub(super) fn profile(&self, name: &str) -> &[String] {
        self.profiles.get(name).map(Vec::as_slice).unwrap_or(&[])
    }
    pub(super) fn profile_names(&self, profiles: &[String]) -> HashSet<String> {
        profiles
            .iter()
            .flat_map(|name| self.profile(name))
            .cloned()
            .collect()
    }
}

#[derive(Clone, Copy)]
pub(crate) struct GuidedCatalogRead<'a> {
    pub name: &'a str,
    pub definition: &'a Value,
    pub category: Option<&'a str>,
    pub tags: &'a [String],
    pub safety_notes: &'a [String],
}
