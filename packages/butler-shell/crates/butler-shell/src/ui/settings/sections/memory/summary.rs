//! `useMemorySummary`: the memory inventory (measured on every load) and the project list.
use butler_ds::ui::blocks::settings_section::SettingsSectionState;
use butler_shell_client::Error;
use gpui::Context;
use serde_json::json;

use super::MemoryPage;
use super::types::{Card, Inventory, MemoryProject, ProjectList};
use crate::ui::settings::state::{Load, fetch};

pub(super) struct Summary {
    pub(super) inventory: Load<Inventory>,
    /// The agent has no inventory (404): the cards read as empty, not as an error.
    missing: bool,
    pub(super) projects: Load<Vec<MemoryProject>>,
    /// `flight` / `pending`: one measure at a time, one more after it when asked meanwhile.
    flight: bool,
    queued: bool,
}

impl Summary {
    pub(super) fn new() -> Self {
        Self {
            inventory: Load::Loading,
            missing: false,
            projects: Load::Loading,
            flight: false,
            queued: false,
        }
    }
}

impl MemoryPage {
    /// `summary.reload()`: POST /memory/inventory/check.
    pub(super) fn reload_summary(&mut self, cx: &mut Context<Self>) {
        if self.summary.flight {
            self.summary.queued = true;
            return;
        }
        self.summary.flight = true;
        fetch(
            cx,
            |client| async move { client.check_memory_inventory(&json!({})).await },
            |this: &mut Self, result: Result<Inventory, Error>, cx| {
                this.summary.flight = false;
                match result {
                    Ok(inventory) => {
                        this.summary.missing = false;
                        if let Some(operation) = inventory.operation.clone() {
                            this.accept_cleanup(operation.clone(), false, cx);
                            this.accept_reset(operation, false, cx);
                        }
                        this.summary.inventory = Load::Ready(inventory);
                    }
                    Err(error) => {
                        this.summary.missing = matches!(error, Error::Http(404));
                        this.summary.inventory = Load::Failed;
                    }
                }
                if std::mem::take(&mut this.summary.queued) {
                    this.reload_summary(cx);
                }
            },
        );
    }

    /// `summary.reloadProjects()`: GET /projects.
    pub(super) fn reload_projects(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.list_projects(false).await },
            |this: &mut Self, result: Result<ProjectList, Error>, cx| {
                this.summary.projects = match result {
                    Ok(list) => Load::Ready(list.projects),
                    Err(_) => Load::Failed,
                };
                this.project.memory = Load::Loading;
                this.reload_project(cx);
            },
        );
    }

    pub(super) fn card(&self, kind: &str) -> Option<&Card> {
        match &self.summary.inventory {
            Load::Ready(inventory) => inventory.kinds.iter().find(|card| card.kind == kind),
            _ => None,
        }
    }

    /// `summary.inventory?.revision ?? 0`
    pub(super) fn revision(&self) -> u64 {
        match &self.summary.inventory {
            Load::Ready(inventory) => inventory.revision,
            _ => 0,
        }
    }

    pub(super) fn summary_ready(&self) -> bool {
        matches!(self.summary.inventory, Load::Ready(_))
    }

    /// `summary.state`
    fn summary_state(&self) -> SettingsSectionState {
        match &self.summary.inventory {
            Load::Failed if self.summary.missing => SettingsSectionState::Empty,
            other => other.state(|_| false),
        }
    }

    /// `cardState(summary.state, card)`
    pub(super) fn card_state(&self, card: Option<&Card>) -> SettingsSectionState {
        match self.summary_state() {
            SettingsSectionState::Ready
                if card.is_none_or(|card| card.health.state.as_deref() == Some("unavailable")) =>
            {
                SettingsSectionState::Empty
            }
            state => state,
        }
    }
}
