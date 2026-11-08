//! `useProjectMemory` and `ProjectMemoryBody`: one project's memory, chosen from the projects,
//! and its reset.
use butler_ds::ui::blocks::settings_action_field::SettingsActionField;
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::blocks::surface_panel::{Elevation, SurfacePanel};
use butler_ds::ui::context::Lang;
use butler_shell_client::Error;
use gpui::{Context, ParentElement as _, SharedString};

use super::MemoryPage;
use super::copy::Words;
use super::facts::memory_facts;
use super::reset::{ResetKind, ResetState};
use super::types::{MemoryProject, ProjectInfo};
use crate::ui::settings::controls::{SettingsOption, SettingsSelect};
use crate::ui::settings::state::{Load, fetch};

pub(super) struct Project {
    /// The project the owner chose; the first one until then.
    selection: String,
    pub(super) memory: Load<ProjectInfo>,
    /// The agent has no memory for the project (404).
    missing: bool,
}

impl Project {
    pub(super) fn new() -> Self {
        Self {
            selection: String::new(),
            memory: Load::Loading,
            missing: false,
        }
    }
}

impl MemoryPage {
    fn projects(&self) -> &[MemoryProject] {
        match &self.summary.projects {
            Load::Ready(projects) => projects,
            _ => &[],
        }
    }

    /// `selected`: the chosen project when it still exists, else the first.
    pub(super) fn selected_project(&self) -> Option<&MemoryProject> {
        let projects = self.projects();
        projects
            .iter()
            .find(|project| project.id == self.project.selection)
            .or(projects.first())
    }

    pub(super) fn project_info(&self) -> Option<&ProjectInfo> {
        match &self.project.memory {
            Load::Ready(info) => Some(info),
            _ => None,
        }
    }

    /// `project.reload`: GET /memory/projects/{id}.
    pub(super) fn reload_project(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.selected_project().map(|project| project.id.clone()) else {
            return;
        };
        fetch(
            cx,
            move |client| async move { client.get_memory_project(&id).await },
            |this: &mut Self, result: Result<ProjectInfo, Error>, _| match result {
                Ok(info) => {
                    this.project.missing = false;
                    this.project.memory = Load::Ready(info);
                }
                Err(error) => {
                    this.project.missing = matches!(error, Error::Http(404));
                    this.project.memory = Load::Failed;
                }
            },
        );
    }

    fn select_project(&mut self, id: &SharedString, cx: &mut Context<Self>) {
        self.project.selection = id.to_string();
        self.project.memory = Load::Loading;
        self.project.missing = false;
        self.reload_project(cx);
    }

    /// `projectState`
    fn project_state(&self) -> SettingsSectionState {
        match &self.summary.projects {
            Load::Ready(projects) if projects.is_empty() => SettingsSectionState::Empty,
            Load::Ready(_) if self.project.missing => SettingsSectionState::Empty,
            Load::Ready(_) => self.project.memory.state(|_| false),
            other => other.state(|_| false),
        }
    }

    pub(super) fn project_section(
        &self,
        copy: &Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let state = self.project_state();
        let empty = if self.projects().is_empty() {
            copy.no_projects
        } else {
            copy.unavailable
        };
        let mut section =
            SettingsSection::new("project-memory", SettingsSectionKind::Form, copy.titles[5])
                .description(copy.descriptions[5])
                .state(state)
                .empty_message(empty)
                .on_retry(cx.listener(|this, _, _, cx| {
                    Self::reload_projects(cx);
                    this.reload_project(cx);
                }));
        if state != SettingsSectionState::Ready {
            return section;
        }
        let running = self.reset.kind() == Some(ResetKind::Project);
        let info = self.project_info();
        let selected = self
            .selected_project()
            .map(|project| project.id.clone())
            .unwrap_or_default();
        let options = self
            .projects()
            .iter()
            .map(|project| SettingsOption::new(project.id.clone(), project.display_name.clone()))
            .collect();
        let page = cx.weak_entity();
        let select = SettingsSelect::new("memory-project", copy.project, selected)
            .options(options)
            .disabled(running)
            .on_change(move |id, _, cx| {
                let _ = page.update(cx, |this, cx| this.select_project(id, cx));
            });
        let reset_state = ResetState {
            running,
            ready: info
                .is_some_and(|info| info.conversations.is_some() && info.instructions.is_some()),
            empty: info.is_some_and(|info| {
                info.summary_bytes.unwrap_or(0) == 0
                    && info.conversations == Some(0)
                    && info.instructions == Some(0)
            }),
        };
        let reset = self.reset_button("reset-project", copy, ResetKind::Project, reset_state, cx);
        let field = SettingsActionField::new(
            copy.reset_project_label,
            copy.reset_project_description,
            reset,
        )
        .details(
            SurfacePanel::new()
                .elevation(Elevation::Subtle)
                .child(memory_facts(None, info, copy, lang)),
        )
        .setting_id("reset-project-memory");
        section = section.child(select).child(field);
        section
    }
}
