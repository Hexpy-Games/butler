//! Worker profiles on the Models page (`WorkerProfileControls.tsx`, `useWorkerProfiles.ts`): the
//! Advanced section's list of editable profiles. Its entity holds the one piece of state React
//! keeps in the editors (which profiles show the custom job field); the page observes it.
mod editor;
mod updates;

use std::collections::HashSet;
use std::rc::Rc;

use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use gpui::{App, Context, ParentElement as _};
use serde::Deserialize;
use serde_json::{Value, json};

use super::root::copy;
use crate::ui::Icon;
use crate::ui::composer::menus::ModelChoice;
use crate::ui::settings::controls::SettingsInput;
use crate::ui::settings::{Save, SectionCtx};
use updates::{LIMIT, Partial, create_profile, merged, simultaneous_workers, without};

#[derive(Default, Deserialize)]
struct Slice {
    #[serde(default)]
    worker_profiles: Vec<Value>,
    #[serde(default)]
    max_simultaneous_workers: u32,
}

/// The profiles as the last render read them, and how to save a change to them.
#[derive(Clone)]
struct Edit {
    ctx: SectionCtx,
    profiles: Rc<Vec<Value>>,
    index: usize,
}

impl Edit {
    fn at(&self, index: usize) -> Self {
        Self {
            index,
            ..self.clone()
        }
    }

    fn save(&self, profiles: &[Value], cx: &mut App) {
        let patch = json!({ "worker_profiles": profiles });
        self.ctx.save(patch, Save::default(), cx);
    }

    /// `updateProfile`
    fn apply(&self, partial: Partial, cx: &mut App) {
        let mut next = (*self.profiles).clone();
        if let Some(profile) = next.get_mut(self.index) {
            *profile = merged(profile, partial);
        }
        self.save(&next, cx);
    }

    /// `addProfile`
    fn add(&self, models: &[ModelChoice], cx: &mut App) {
        if let Some(created) = create_profile(&self.profiles, models) {
            let mut next = (*self.profiles).clone();
            next.push(created);
            self.save(&next, cx);
        }
    }

    /// `deleteProfile`
    fn delete(&self, id: &str, cx: &mut App) {
        let remaining = without(&self.profiles, id);
        if remaining.len() != self.profiles.len() {
            self.save(&remaining, cx);
        }
    }
}

pub(super) struct WorkerProfiles {
    ctx: SectionCtx,
    /// `customSelection` of each profile's task fields, by profile id.
    custom_jobs: HashSet<String>,
}

impl WorkerProfiles {
    pub(super) fn new(ctx: SectionCtx, cx: &mut Context<Self>) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        Self {
            ctx,
            custom_jobs: HashSet::new(),
        }
    }

    fn set_custom(&mut self, id: &str, custom: bool, cx: &mut Context<Self>) {
        if custom {
            self.custom_jobs.insert(id.to_owned());
        } else {
            self.custom_jobs.remove(id);
        }
        cx.notify();
    }

    /// The `worker-profiles` section: the add action, max simultaneous workers, one editor per
    /// profile.
    pub(super) fn section(&mut self, cx: &mut Context<Self>) -> SettingsSection {
        let words = copy::get(cx);
        let state = self.ctx.state.read(cx);
        let slice: Slice = state.slice().unwrap_or_default();
        let (saving, models) = (state.saving(), Rc::new(state.runtime_models()));
        let can_add = slice.worker_profiles.len() < LIMIT;
        let edit = Edit {
            ctx: self.ctx.clone(),
            profiles: Rc::new(slice.worker_profiles),
            index: 0,
        };
        let add = {
            let (edit, models) = (edit.clone(), models.clone());
            Button::new("worker-profile-add")
                .size(Size::Sm)
                .variant(Variant::Outline)
                .icon_start(icon(Icon::Plus, IconSize::Md, Ds::get(cx)))
                .text(words.worker_add)
                .on_click(move |_, _, cx| edit.add(&models, cx))
        };
        let add = if saving || !can_add {
            add.disabled()
        } else {
            add
        };
        let current = slice.max_simultaneous_workers;
        let ctx = self.ctx.clone();
        let max = SettingsInput::new(
            "worker-max-simultaneous",
            words.worker_max_simultaneous,
            current.to_string(),
        )
        .on_commit(move |raw, _, cx| {
            if let Some(value) = simultaneous_workers(&raw, current) {
                let patch = json!({ "max_simultaneous_workers": value });
                ctx.save(patch, Save::default(), cx);
            }
        });
        let row = editor::Row {
            edit: edit.clone(),
            models,
            saving,
            custom: false,
            page: cx.entity(),
            words,
            lang: Ds::get(cx).lang(),
        };
        let editors: Vec<_> = edit
            .profiles
            .iter()
            .enumerate()
            .filter_map(|(index, raw)| {
                let profile = serde_json::from_value(raw.clone()).ok()?;
                let row = editor::Row {
                    edit: edit.at(index),
                    custom: self.custom_jobs.contains(&profile_id(raw)),
                    ..row.clone()
                };
                Some(editor::editor(&row, profile))
            })
            .collect();
        let mut section = SettingsSection::new(
            "worker-profiles",
            SettingsSectionKind::List,
            words.worker_profiles_section,
        )
        .actions(add)
        .holds_fields();
        if !can_add {
            section = section.description(words.worker_add_limit_reached);
        }
        section.child(max).children(editors)
    }
}

fn profile_id(raw: &Value) -> String {
    raw.get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
