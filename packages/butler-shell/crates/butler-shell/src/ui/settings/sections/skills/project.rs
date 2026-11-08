//! `ProjectSkillsSection.tsx`: the project picker filters the list; import and create add to the
//! picked project.
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::button::{self, Size};
use butler_ds::ui::field::FieldError;
use butler_ds::ui::select::{Select, SelectContent, SelectItem, SelectTrigger};
use butler_ds::ui::select_button::Size as TriggerSize;
use gpui::{Context, IntoElement as _, ParentElement as _, SharedString, Window, div};

use super::SkillsPage;
use super::copy::SkillsCopy;
use super::group::{skill_actions, skill_group};
use super::types::SkillProject;

impl SkillsPage {
    /// The `project-skills` section. `state` is the page's fetch state.
    pub(super) fn project_section(
        &self,
        state: SettingsSectionState,
        copy: &'static SkillsCopy,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let project = self.selected_project();
        let error = project.and_then(|project| {
            self.import_failure(Some(&project.id))
                .then_some(copy.import_failed)
        });
        let shown = if state == SettingsSectionState::Ready
            && project.is_none_or(|project| project.skills.is_empty())
            && error.is_none()
        {
            SettingsSectionState::Empty
        } else {
            state
        };
        let mut section = SettingsSection::new(
            "project-skills",
            SettingsSectionKind::List,
            copy.project_skills,
        )
        .state(shown)
        .on_retry(cx.listener(|page, _, _, cx| page.refresh(cx)))
        .empty_message(if project.is_some() {
            copy.no_skills
        } else {
            copy.no_projects
        });
        if let Some(project) = project {
            let picker = self.project_picker(project, window, cx);
            let (import, create) = (project.id.clone(), project.id.clone());
            let actions = skill_actions(
                "project-skills",
                copy,
                cx.listener(move |page, _, _, cx| page.import_skill(Some(import.clone()), cx)),
                cx.listener(move |_, _, _, cx| Self::create_chat(Some(create.clone()), cx)),
            );
            section = section.actions(button::container(Size::Sm).child(picker).child(actions));
        }
        if let Some(message) = error {
            section = section.child(FieldError::new().errors([message]));
        }
        if let Some(project) = project.filter(|project| !project.skills.is_empty()) {
            section = section.child(skill_group(
                "project-skills-list",
                &project.skills,
                None,
                cx,
            ));
        }
        section
    }

    /// The project `Select`, small.
    fn project_picker(
        &self,
        project: &SkillProject,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let weak = cx.entity().downgrade();
        let select = Select::new("skills-project", window, cx)
            .value(Some(SharedString::from(project.id.clone())))
            .on_value_change(move |id, _, cx| {
                let _ = weak.update(cx, |page, cx| {
                    page.project_id = Some(id.to_string());
                    cx.notify();
                });
            });
        let content = self.view.iter().flat_map(|view| &view.projects).fold(
            SelectContent::new(),
            |content, item| {
                content.child(SelectItem::new(item.id.clone(), item.display_name.clone()))
            },
        );
        let trigger = select.trigger(
            SelectTrigger::new("skills-project-trigger").size(TriggerSize::Sm),
            &content,
            cx,
        );
        let list = select.content(&content, window, cx);
        div().child(trigger).child(list).into_any_element()
    }
}
