//! The API keys section (`SavedKeysRows.tsx`, `SavedKeyRow.tsx`, `SavedKeyReplaceField.tsx`).
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::icon::IconSize;
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::text::Input;
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement as _, KeyDownEvent,
    ParentElement as _, SharedString, Styled as _, div,
};

use super::keys::{Check, Rule, SavedKey};
use super::{SecurityAuthority, glyph};
use crate::ui::Icon;
use crate::ui::settings::controls::provider_mark;
use crate::ui::settings::state::Load;

/// Where the key is kept, as the agent reports it: an index into `Words::storage`.
fn storage_index(storage: Option<&str>) -> usize {
    match storage {
        Some("vault") => 4,
        Some("keychain") => 1,
        Some("secret_service") => 2,
        Some("credential_manager") => 3,
        _ => 0,
    }
}

impl SecurityAuthority {
    pub(super) fn keys_section(&mut self, cx: &mut Context<Self>) -> SettingsSection {
        let words = Self::words(cx);
        let state = self.keys.list.state(std::vec::Vec::is_empty);
        let this = cx.entity();
        let mut section =
            SettingsSection::new("saved-keys", SettingsSectionKind::List, words.keys_title)
                .state(state)
                .empty_message(words.keys_empty)
                .on_retry(move |_, _, cx| this.update(cx, |this, cx| this.load_keys(false, cx)));
        if let (SettingsSectionState::Ready, Load::Ready(keys)) = (state, &self.keys.list) {
            for key in keys {
                section = section.child(self.key_row(key, cx));
            }
        }
        section
    }

    /// `SavedKeyRow`: provider, masked key, the models using it, where it is kept; Replace and
    /// Delete.
    fn key_row(&self, key: &SavedKey, cx: &mut Context<Self>) -> AnyElement {
        let words = Self::words(cx);
        let name = self.key_name(key, cx);
        let blocked = matches!(self.delete_rule(key, cx), Rule::Blocked);
        let busy = self.keys.busy.as_deref() == Some(key.id.as_str());
        let replacing = self.keys.replacing.as_deref() == Some(key.id.as_str());
        let details = format!(
            "{} · {}",
            words.used_by(key.model_refs.len()),
            words.storage[storage_index(key.storage.as_deref())]
        );
        let title = Stack::new()
            .gap(Space::Xs)
            .child(Typo::panel_section_title(name))
            .child(Typo::caption(key.masked_value.clone()))
            .child(Typo::caption(details).tone(Tone::Tertiary));
        let identity = Stack::row()
            .cross(Cross::Start)
            .gap(Space::Md)
            .child(
                div()
                    .flex_none()
                    .child(provider_mark(&key.provider_id, None, true)),
            )
            .child(title);
        let (this, id) = (cx.entity(), key.id.clone());
        let replace = Button::new(SharedString::from(format!("saved-key-replace-{id}")))
            .variant(Variant::Outline)
            .size(Size::Sm)
            .icon_start(glyph(cx, Icon::RefreshCcw, IconSize::Sm))
            .text(words.replace)
            .when(busy || replacing, Button::disabled)
            .on_click({
                let id = id.clone();
                move |_, _, cx| this.update(cx, |this, cx| this.begin_replace(id.clone(), cx))
            });
        let this = cx.entity();
        let delete = Button::new(SharedString::from(format!("saved-key-delete-{id}")))
            .variant(Variant::Outline)
            .size(Size::Sm)
            .icon_start(glyph(cx, Icon::Trash2, IconSize::Sm))
            .text(words.delete)
            .when(busy || replacing || blocked, Button::disabled)
            .on_click({
                let id = id.clone();
                move |_, _, cx| this.update(cx, |this, cx| this.begin_delete(&id, cx))
            });
        let delete = if blocked {
            Tooltip::new(SharedString::from(format!("saved-key-delete-tip-{id}")))
                .label(words.delete_default_hint)
                .child(delete)
                .into_any_element()
        } else {
            delete.into_any_element()
        };
        let header = Stack::row()
            .justify(Justify::Between)
            .cross(Cross::Center)
            .gap(Space::Md)
            .wrap(true)
            .child(identity)
            .child(button::container(Size::Sm).child(replace).child(delete));
        Stack::new()
            .gap(Space::Sm)
            .child(header)
            .when(replacing, |stack| {
                stack.child(self.replace_field(&key.id, cx))
            })
            .into_any_element()
    }

    /// `SavedKeyReplaceField`: the new key, checked with the provider on Save. Enter saves and
    /// Escape cancels (and does not close the settings).
    /// CARVE-OUT(focus): it does not take focus when it opens (the DS Input has no focus handle).
    fn replace_field(&self, key_id: &str, cx: &mut Context<Self>) -> AnyElement {
        let words = Self::words(cx);
        let check = self.keys.check;
        let on_change = cx.entity();
        let input = Input::new(SharedString::from(format!("saved-key-{key_id}")))
            .masked()
            .value(self.keys.draft.clone())
            .when(check == Check::Failed, Input::invalid)
            .on_change(move |text, _, cx| {
                on_change.update(cx, |this, cx| this.edit_draft(text, cx));
            });
        let status = match check {
            Check::Failed => Some(
                Typo::caption(words.key_save_failed)
                    .tone(Tone::Danger)
                    .into_any_element(),
            ),
            Check::Checking => Some(
                Stack::row()
                    .cross(Cross::Center)
                    .gap(Space::Xs)
                    .child(
                        Spinner::new(SharedString::from(format!("saved-key-spinner-{key_id}")))
                            .size(14.),
                    )
                    .child(Typo::caption(words.checking).tone(Tone::Secondary))
                    .into_any_element(),
            ),
            Check::Idle => None,
        };
        let (on_cancel, on_save) = (cx.entity(), cx.entity());
        let cancel = Button::new(SharedString::from(format!("saved-key-cancel-{key_id}")))
            .variant(Variant::Outline)
            .size(Size::Sm)
            .text(words.cancel)
            .when(check == Check::Checking, Button::disabled)
            .on_click(move |_, _, cx| {
                on_cancel.update(cx, |this, cx| {
                    this.end_replace();
                    cx.notify();
                });
            });
        let save = Button::new(SharedString::from(format!("saved-key-save-{key_id}")))
            .size(Size::Sm)
            .text(words.save)
            .when(!self.draft_ready(), Button::disabled)
            .on_click(move |_, _, cx| on_save.update(cx, super::SecurityAuthority::submit_replace));
        let on_key = cx.entity();
        div()
            .on_key_down(
                move |event: &KeyDownEvent, _, cx| match event.keystroke.key.as_str() {
                    "enter" => on_key.update(cx, super::SecurityAuthority::submit_replace),
                    "escape" => {
                        on_key.update(cx, |this, cx| {
                            if this.keys.check != Check::Checking {
                                this.end_replace();
                                cx.notify();
                            }
                        });
                        cx.stop_propagation();
                    }
                    _ => {}
                },
            )
            .child(
                Field::new(SharedString::from(format!("saved-key-field-{key_id}")))
                    .child(FieldLabel::new().child(words.new_key))
                    .child(input)
                    .children(status)
                    .child(button::container(Size::Sm).child(cancel).child(save)),
            )
            .into_any_element()
    }
}
