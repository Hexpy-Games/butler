//! One worker profile's editor (`WorkerProfileEditor.tsx`, `WorkerProfileTaskFields.tsx`).
use std::rc::Rc;

use butler_ds::ui::blocks::settings_field::SettingsFieldGroup;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Lang;
use butler_ds::ui::layout::{Justify, Stack};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window};
use serde_json::json;

use super::super::root::copy::Words;
use super::super::root::data::model_options;
use super::updates::{BUILTIN_JOBS, DEFAULT_ID, Field, Job, Profile, select_model, text_patch};
use super::{Edit, WorkerProfiles};
use crate::ui::composer::menus::ModelChoice;
use crate::ui::composer::queue::effort_wire;
use crate::ui::settings::controls::{
    ReasoningSelect, SettingsInput, SettingsOption, SettingsSelect, SettingsSwitch,
};
use crate::ui::source::wire::ReasoningEffort;

/// What an editor needs besides the profile.
#[derive(Clone)]
pub(super) struct Row {
    pub(super) edit: Edit,
    pub(super) models: Rc<Vec<ModelChoice>>,
    pub(super) saving: bool,
    /// The custom job field is open although the profile's job is a builtin.
    pub(super) custom: bool,
    pub(super) page: Entity<WorkerProfiles>,
    pub(super) words: &'static Words,
    pub(super) lang: Lang,
}

/// A text input that saves its trimmed text as `field` when it changes the profile.
fn commit(
    edit: &Edit,
    profile: &Rc<Profile>,
    field: Field,
) -> impl Fn(SharedString, &mut Window, &mut App) + 'static {
    let (edit, profile) = (edit.clone(), profile.clone());
    move |raw, _, cx| {
        if let Some(partial) = text_patch(&profile, field, &raw) {
            edit.apply(partial, cx);
        }
    }
}

/// The job select, the custom job text, domain and prompt (`WorkerProfileTaskFields`).
fn task_fields(
    row: &Row,
    profile: &Rc<Profile>,
    key: &dyn Fn(&str) -> SharedString,
) -> Vec<AnyElement> {
    let words = row.words;
    let custom = row.custom || matches!(profile.job, Job::Custom { .. });
    let builtin = match &profile.job {
        Job::Builtin { job } if !custom => Some(job.clone()),
        _ => None,
    };
    let value = builtin.clone().unwrap_or_else(|| "custom".to_owned());
    let mut options: Vec<SettingsOption> = BUILTIN_JOBS
        .iter()
        .zip(words.job_labels)
        .map(|(job, label)| SettingsOption::new(*job, label))
        .collect();
    options.push(SettingsOption::new("custom", words.job_custom));
    let (edit, page, id) = (row.edit.clone(), row.page.clone(), profile.id.clone());
    let select = SettingsSelect::new(key("worker-job"), words.job, value)
        .options(options)
        .disabled(row.saving)
        .on_change(move |value, _, cx| {
            let value: &str = value;
            if BUILTIN_JOBS.contains(&value) {
                if builtin.as_deref() == Some(value) {
                    return;
                }
                page.update(cx, |page, cx| page.set_custom(&id, false, cx));
                let job = json!({ "kind": "builtin", "job": value });
                edit.apply(vec![("job", job)], cx);
            } else if value == "custom" {
                page.update(cx, |page, cx| page.set_custom(&id, true, cx));
            }
        });
    let mut fields = vec![select.into_any_element()];
    if custom {
        let text = match &profile.job {
            Job::Custom { text } => text.clone(),
            Job::Builtin { .. } => String::new(),
        };
        let (edit, page, id, profile) = (
            row.edit.clone(),
            row.page.clone(),
            profile.id.clone(),
            profile.clone(),
        );
        let input = SettingsInput::new(key("worker-custom-job"), words.custom_job, text).on_commit(
            move |raw, _, cx| match text_patch(&profile, Field::Job, &raw) {
                Some(partial) => edit.apply(partial, cx),
                None => page.update(cx, |page, cx| page.set_custom(&id, false, cx)),
            },
        );
        fields.push(input.into_any_element());
    }
    let domain = profile.domain.clone().unwrap_or_default();
    let prompt = profile.prompt.clone().unwrap_or_default();
    fields.push(
        SettingsInput::new(key("worker-domain"), words.domain, domain)
            .on_commit(commit(&row.edit, profile, Field::Domain))
            .into_any_element(),
    );
    fields.push(
        SettingsInput::new(key("worker-prompt"), words.worker_prompt, prompt)
            .on_commit(commit(&row.edit, profile, Field::Prompt))
            .into_any_element(),
    );
    fields
}

/// The model select and its reasoning select.
fn model_fields(
    row: &Row,
    profile: &Profile,
    key: &dyn Fn(&str) -> SharedString,
) -> Vec<AnyElement> {
    let words = row.words;
    let selected = row
        .models
        .iter()
        .find(|model| *model.model_ref == *profile.model)
        .or_else(|| row.models.first())
        .cloned();
    let value = selected
        .as_ref()
        .map_or_else(SharedString::default, |model| model.model_ref.clone());
    let effort = profile
        .reasoning_effort
        .clone()
        .unwrap_or(ReasoningEffort::Medium);
    let (edit, models, current) = (row.edit.clone(), row.models.clone(), effort.clone());
    let model = SettingsSelect::new(key("worker-model"), words.model, value)
        .options(model_options(&row.models, row.lang))
        .disabled(row.saving)
        .on_change(move |value, _, cx| {
            edit.apply(select_model(&models, value, &current), cx);
        });
    let edit = row.edit.clone();
    let reasoning = ReasoningSelect::new(
        key("worker-reasoning"),
        words.reasoning,
        selected.as_ref(),
        effort,
    )
    .disabled(row.saving)
    .on_change(move |effort, _, cx| {
        if let Some(wire) = effort_wire(effort) {
            edit.apply(vec![("reasoning_effort", json!(wire))], cx);
        }
    });
    vec![model.into_any_element(), reasoning.into_any_element()]
}

pub(super) fn editor(row: &Row, profile: Profile) -> SettingsFieldGroup {
    let words = row.words;
    let is_default = profile.id == DEFAULT_ID;
    let id = profile.id.clone();
    let key = move |name: &str| SharedString::from(format!("{name}-{id}"));
    let profile = Rc::new(profile);
    let edit = row.edit.clone();
    let enabled = SettingsSwitch::new(key("worker-enabled"), words.enabled)
        .checked(profile.enabled)
        .disabled(row.saving || is_default)
        .on_change(move |checked, _, cx| {
            if !is_default {
                edit.apply(vec![("enabled", json!(checked))], cx);
            }
        });
    let name = SettingsInput::new(key("worker-name"), words.name, profile.label.clone())
        .on_commit(commit(&row.edit, &profile, Field::Label));
    let mut group = SettingsFieldGroup::new()
        .child(Typo::panel_section_title(profile.label.clone()))
        .child(name)
        .child(enabled)
        .children(task_fields(row, &profile, &key))
        .children(model_fields(row, &profile, &key));
    if !is_default {
        let (edit, id) = (row.edit.clone(), profile.id.clone());
        let delete = Button::new(key("worker-profile-delete"))
            .size(Size::Sm)
            .variant(Variant::Destructive)
            .text(words.delete)
            .on_click(move |_, _, cx| edit.delete(&id, cx));
        let delete = if row.saving {
            delete.disabled()
        } else {
            delete
        };
        group = group.child(Stack::row().justify(Justify::End).child(delete));
    }
    group
}
