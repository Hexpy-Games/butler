//! Import from other AIs, the memory row (`PersonalizationProfileMigration.tsx`,
//! `useProfileMigrationPrompt.ts`, `app/profileMigrationFeedback.ts`, `importProfileMigration` of
//! `stores/settingsUIStore.ts`).
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::blocks::settings_field::{ControlWidth, SettingsField, SettingsFieldGroup};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Justify, MinWidth, Space, Stack, StackItem, WithItem as _};
use butler_ds::ui::text::Textarea;
use butler_ds::ui::toast::Toast;
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::Error;
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, ClickEvent, ClipboardItem, Context, IntoElement as _, ParentElement as _,
    SharedString,
};
use serde::Deserialize;
use serde_json::json;

use super::copy::{Words, migration_applied, words};
use super::draft::{Draft, Personalization};
use super::{PersonalizationPage, notify};
use crate::ui::Icon;
use crate::ui::settings::state::fetch;

/// `StatusTone`: ok, muted or error.
#[derive(Clone, Copy)]
pub(super) enum Outcome {
    Ok,
    Muted,
    Error,
}

pub(super) struct Feedback {
    outcome: Outcome,
    label: SharedString,
}

impl Feedback {
    fn new(outcome: Outcome, label: impl Into<SharedString>) -> Self {
        Self {
            outcome,
            label: label.into(),
        }
    }

    /// `notifyStatus(label, { tone })`
    fn toast(&self) -> Toast {
        match self.outcome {
            Outcome::Ok => Toast::success(self.label.clone()),
            Outcome::Muted => Toast::message(self.label.clone()),
            Outcome::Error => Toast::error(self.label.clone()),
        }
    }
}

#[derive(Default)]
pub(super) struct Migration {
    expanded: bool,
    dump: String,
    submitting: bool,
    feedback: Option<Feedback>,
    prompt: String,
}

#[derive(Deserialize)]
struct PromptView {
    #[serde(default)]
    prompt: String,
}

/// POST /personalization/profile-import
#[derive(Deserialize)]
struct MigrationResult {
    #[serde(default)]
    profiling_enabled: bool,
    #[serde(default)]
    promoted_count: u64,
    #[serde(default)]
    imported_candidate_count: u64,
    personalization: Personalization,
}

/// `profileMigrationFeedbackFromResult`
fn feedback_from(result: &MigrationResult, lang: butler_ds::ui::context::Lang) -> Feedback {
    let copy = words(lang);
    if !result.profiling_enabled {
        Feedback::new(Outcome::Muted, copy.err_migration_profiling_off)
    } else if result.promoted_count > 0 {
        Feedback::new(Outcome::Ok, migration_applied(lang, result.promoted_count))
    } else if result.imported_candidate_count > 0 {
        Feedback::new(Outcome::Muted, copy.migration_stored)
    } else {
        Feedback::new(Outcome::Muted, copy.migration_no_new_info)
    }
}

impl PersonalizationPage {
    /// Opening the row reads the prompt for the app language (`useProfileMigrationPrompt`).
    fn toggle_migration(&mut self, cx: &mut Context<Self>) {
        self.migration.expanded = !self.migration.expanded;
        if self.migration.expanded {
            let korean = self.language(cx).as_deref() == Some("ko");
            let locale = if korean { "ko" } else { "en" };
            fetch(
                cx,
                move |client| async move { client.get_profile_import_prompt(Some(locale)).await },
                |this: &mut Self, result: Result<PromptView, Error>, _| {
                    this.migration.prompt = result.map(|view| view.prompt).unwrap_or_default();
                },
            );
        }
        cx.notify();
    }

    /// `submitProfileMigration` with the store's `importProfileMigration`.
    fn submit_migration(&mut self, cx: &mut Context<Self>) {
        let text = self.migration.dump.trim().to_owned();
        if text.is_empty() {
            return;
        }
        let copy = words(Ds::get(cx).lang());
        self.migration.submitting = true;
        self.saving = true;
        self.migration.feedback = Some(Feedback::new(Outcome::Muted, copy.migration_importing));
        notify(
            &mut self.migration_toast,
            Toast::loading(copy.migration_importing),
            cx,
        );
        fetch(
            cx,
            move |client| async move {
                client
                    .import_personalization_profile(&json!({ "text": text }))
                    .await
            },
            |this: &mut Self, result: Result<MigrationResult, Error>, cx| {
                this.migrated(result, cx);
            },
        );
        cx.notify();
    }

    fn migrated(&mut self, result: Result<MigrationResult, Error>, cx: &mut Context<Self>) {
        self.migration.submitting = false;
        self.saving = false;
        let lang = Ds::get(cx).lang();
        let feedback = match result {
            Ok(result) => {
                let feedback = feedback_from(&result, lang);
                if result.profiling_enabled {
                    self.migration.dump.clear();
                }
                self.draft = Draft::from(&result.personalization);
                self.personalization = Some(result.personalization);
                feedback
            }
            Err(_) => Feedback::new(Outcome::Error, words(lang).err_migration),
        };
        notify(&mut self.migration_toast, feedback.toast(), cx);
        self.migration.feedback = Some(feedback);
    }

    /// The migration row, its status line and, when open, the prompt and the content fields.
    pub(super) fn migration_rows(
        &self,
        copy: &Words,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let migration = &self.migration;
        let loaded = self.personalization.is_some();
        let toggle = Button::new("profile-migration-import")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(if migration.expanded {
                copy.migration_close
            } else {
                copy.migration_open
            })
            .when(busy || !loaded, Button::disabled)
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_migration(cx)));
        let row = ListRow::new(copy.migration_title)
            .icon(icon(Icon::Sparkles, IconSize::Md, Ds::get(cx)))
            .description(copy.migration_description);
        let mut rows = vec![
            Stack::row()
                .cross(Cross::Center)
                .gap(Space::Sm)
                .child(StackItem::new().grow().min_width(MinWidth::Zero).child(row))
                .child(toggle)
                .into_any_element(),
        ];
        if let Some(feedback) = &migration.feedback {
            let tone = match feedback.outcome {
                Outcome::Ok => Tone::Success,
                Outcome::Muted => Tone::Secondary,
                Outcome::Error => Tone::Danger,
            };
            rows.push(
                Typo::caption(feedback.label.clone())
                    .tone(tone)
                    .into_any_element(),
            );
        }
        if migration.expanded {
            rows.push(self.migration_fields(copy, busy, cx));
        }
        rows
    }

    fn migration_fields(&self, copy: &Words, busy: bool, cx: &mut Context<Self>) -> AnyElement {
        let migration = &self.migration;
        let prompt = migration.prompt.clone();
        let prompt_field = SettingsField::new(copy.migration_prompt)
            .setting_id("profile-migration-prompt")
            .control_width(ControlWidth::Full)
            .control(
                Textarea::new("profile-migration-prompt")
                    .value(prompt.clone())
                    .rows(8)
                    .read_only(),
            )
            .after_control(
                Stack::row().justify(Justify::End).child(
                    Button::new("profile-migration-copy")
                        .variant(Variant::Outline)
                        .text(copy.migration_copy)
                        .when(prompt.is_empty(), Button::disabled)
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(prompt.clone()));
                        }),
                ),
            );
        let locked = busy || migration.submitting || self.personalization.is_none();
        let dump = Textarea::new("profile-migration-dump")
            .value(migration.dump.clone())
            .placeholder(copy.migration_dump_placeholder)
            .rows(8)
            .when(locked, Textarea::disabled)
            .on_change(cx.listener(|this, value: &str, _, cx| {
                value.clone_into(&mut this.migration.dump);
                this.migration.feedback = None;
                cx.notify();
            }));
        let submit = Button::new("profile-migration-submit")
            .text(if migration.submitting {
                copy.migration_running
            } else {
                copy.migration_import
            })
            .when(locked || migration.dump.trim().is_empty(), Button::disabled)
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.submit_migration(cx)));
        let dump_field = SettingsField::new(copy.migration_dump)
            .setting_id("profile-migration-dump")
            .control_width(ControlWidth::Full)
            .control(dump)
            .after_control(Stack::row().justify(Justify::End).child(submit));
        SettingsFieldGroup::new()
            .child(prompt_field)
            .child(dump_field)
            .into_any_element()
    }
}
