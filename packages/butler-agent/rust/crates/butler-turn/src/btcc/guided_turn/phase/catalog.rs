use std::collections::{HashMap, HashSet};

use crate::btcc::BtccCode;
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuidedCatalogTool {
    pub(super) name: String,
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
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

/// Whether project ledger effects are enabled for the session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedgerEffects {
    Enabled,
    Disabled,
}

/// The guided tool catalog: tools, profiles and role restrictions.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidedCatalogSnapshot {
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
    pub fn disable_browser(&mut self) {
        self.tools.retain(|tool| !tool.name.starts_with("browser_"));
    }
    /// Every catalog tool.
    pub fn capability_tools(&self) -> impl Iterator<Item = GuidedCatalogRead<'_>> {
        self.tools.iter().map(|tool| GuidedCatalogRead {
            name: &tool.name,
            definition: &tool.definition,
            category: tool.category.as_deref(),
            tags: &tool.tags,
            safety_notes: &tool.safety_notes,
        })
    }

    /// The non-durable (built-in) tools.
    pub fn builtin_tools(&self) -> impl Iterator<Item = GuidedCatalogRead<'_>> {
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

    /// A built-in tool by name.
    pub fn builtin_tool(&self, name: &str) -> Option<GuidedCatalogRead<'_>> {
        self.builtin_tools().find(|tool| tool.name == name)
    }
    /// A builtin tool the native bridge exposes.
    pub fn bridge_tool(
        &self,
        name: &str,
        ledger_effects: LedgerEffects,
    ) -> Option<GuidedCatalogRead<'_>> {
        self.builtin_tool(name)
            .filter(|_| !self.hidden_native_bridge_tool(name, ledger_effects))
    }
    /// Whether a native bridge tool is hidden from the surface.
    pub fn hidden_native_bridge_tool(&self, name: &str, ledger_effects: LedgerEffects) -> bool {
        self.work_tracking.contains(name)
            || (self.project_mutations.contains(name)
                && !(ledger_effects == LedgerEffects::Enabled
                    && self.managed_ledger_effects.contains(name)))
    }
    /// Required profiles are checked against concrete Host executors at admission.
    pub fn profile_tool_names(&self, name: &str) -> Option<&[String]> {
        self.profiles.get(name).map(Vec::as_slice)
    }
    /// Parses the catalog JSON.
    pub fn parse(json: &str) -> Result<Self, crate::btcc::BtccError> {
        serde_json::from_str(json).map_err(|error| {
            crate::btcc::BtccError::detected(BtccCode::GuidedCatalogInvalid, error.to_string())
                .with_source(error)
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

/// A borrowed view of one catalog tool.
#[derive(Clone, Copy)]
pub struct GuidedCatalogRead<'a> {
    pub name: &'a str,
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
    pub definition: &'a Value,
    pub category: Option<&'a str>,
    pub tags: &'a [String],
    pub safety_notes: &'a [String],
}
