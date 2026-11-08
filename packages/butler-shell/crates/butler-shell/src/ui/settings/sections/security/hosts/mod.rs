//! The Advanced section (`SecuritySettings.tsx` `SecurityAdvancedSection`,
//! `SecurityAllowedHostsField.tsx`): extra host names for tunnels and proxies; each change saves
//! the whole list.
mod name;

use butler_ds::ui::blocks::disclosure_row::{DisclosureRow, Surface};
use butler_ds::ui::blocks::settings_field::{SettingsField, SettingsFieldGroup};
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::FieldError;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{
    Basis, Cross, Justify, MinWidth, Space, Stack, StackItem, WithItem as _,
};
use butler_ds::ui::text::Input;
use butler_ds::ui::typo::{Typo, Wrap};
use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement as _, KeyDownEvent,
    ParentElement as _, SharedString, div, prelude::FluentBuilder as _,
};
use serde_json::{Value, json};

use super::SecurityPage;
use super::copy::Words;
use crate::ui::Icon;

/// The text being typed into a list's field.
#[derive(Default)]
pub(super) struct Draft {
    text: String,
    invalid: bool,
}

/// Which list a field edits: `allowed_hosts` or `content_hosts`.
#[derive(Clone, Copy)]
enum List {
    Allowed,
    Content,
}

impl List {
    fn patch(self, hosts: &[String]) -> Value {
        match self {
            Self::Allowed => json!({ "allowed_hosts": hosts }),
            Self::Content => json!({ "content_hosts": hosts }),
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Allowed => "hosts",
            Self::Content => "content-hosts",
        }
    }
}

impl SecurityPage {
    fn draft(&self, list: List) -> &Draft {
        match list {
            List::Allowed => &self.hosts_draft,
            List::Content => &self.content_draft,
        }
    }

    fn draft_mut(&mut self, list: List) -> &mut Draft {
        match list {
            List::Allowed => &mut self.hosts_draft,
            List::Content => &mut self.content_draft,
        }
    }

    fn hosts_of(&self, list: List) -> Vec<String> {
        self.view
            .as_ref()
            .map(|view| match list {
                List::Allowed => view.allowed_hosts.clone(),
                List::Content => view.content_hosts.clone().unwrap_or_default(),
            })
            .unwrap_or_default()
    }

    /// `add`: a valid new host saves the list and clears the field once saved.
    fn add_host(&mut self, list: List, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(host) = name::normalize(&self.draft(list).text) else {
            self.draft_mut(list).invalid = true;
            cx.notify();
            return;
        };
        let mut hosts = self.hosts_of(list);
        if hosts.contains(&host) {
            self.draft_mut(list).text.clear();
            cx.notify();
            return;
        }
        hosts.push(host);
        self.save(
            &list.patch(&hosts),
            move |this| this.draft_mut(list).text.clear(),
            cx,
        );
    }

    fn remove_host(&mut self, list: List, host: &str, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let hosts: Vec<String> = self
            .hosts_of(list)
            .into_iter()
            .filter(|item| item != host)
            .collect();
        self.save(&list.patch(&hosts), |_| {}, cx);
    }

    /// `SecurityAdvancedSection`: collapsed until opened.
    pub(super) fn advanced_section(
        &self,
        copy: &Words,
        cx: &mut Context<Self>,
    ) -> Option<SettingsSection> {
        let view = self.view.as_ref()?;
        let content = view.content_hosts.as_deref().unwrap_or_default();
        let count = view.allowed_hosts.len() + content.len();
        let fields = SettingsFieldGroup::new()
            .child(
                SettingsField::new(copy.hosts)
                    .description(copy.hosts_description)
                    .control(self.host_field(List::Allowed, &view.allowed_hosts, copy, cx)),
            )
            .child(
                SettingsField::new(copy.content_hosts)
                    .description(copy.content_hosts_description)
                    .control(self.host_field(List::Content, content, copy, cx)),
            );
        let row = DisclosureRow::new("settings-security-advanced", copy.advanced_contents)
            .surface(Surface::Plain)
            .meta((copy.host_count)(count))
            .open(self.advanced_open)
            .on_toggle(cx.listener(|this, _, _, cx| {
                this.advanced_open = !this.advanced_open;
                cx.notify();
            }))
            .child(
                Stack::row().gap(Space::None).child(
                    StackItem::new()
                        .basis(Basis::Lg)
                        .min_width(MinWidth::Zero)
                        .child(fields),
                ),
            );
        Some(
            SettingsSection::new(
                "security-advanced",
                SettingsSectionKind::Form,
                copy.advanced,
            )
            .child(row),
        )
    }

    /// `SecurityAllowedHostsField`: the hosts with a remove button each, then the add row.
    fn host_field(
        &self,
        list: List,
        hosts: &[String],
        copy: &Words,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entry_column = self.host_entry(list, copy, cx);
        let prefix = list.prefix();
        let disabled = self.busy;
        let rows = hosts.iter().map(|host| {
            let target = host.clone();
            let remove = IconButton::new(
                SharedString::from(format!("{prefix}-remove-{host}")),
                (copy.remove_host)(host),
            )
            .glyph(Icon::Trash2)
            .when(disabled, IconButton::disabled)
            .on_click(cx.listener(move |this, _, _, cx| this.remove_host(list, &target, cx)));
            Stack::row()
                .gap(Space::Sm)
                .cross(Cross::Center)
                .justify(Justify::Between)
                .child(Typo::code(host.clone()).wrap(Wrap::Anywhere))
                .child(remove)
        });
        let mut column = Stack::new().gap(Space::Md);
        if !hosts.is_empty() {
            column = column.child(Stack::new().gap(Space::Xs).children(rows));
        }
        column.child(entry_column).into_any_element()
    }

    /// The add row of a hosts field and its error.
    fn host_entry(&self, list: List, copy: &Words, cx: &mut Context<Self>) -> Stack {
        let placeholder = match list {
            List::Allowed => copy.host_placeholder,
            List::Content => copy.content_host_placeholder,
        };
        let prefix = list.prefix();
        let draft = self.draft(list);
        let disabled = self.busy;
        let ds = Ds::get(cx);
        let page = cx.entity().downgrade();
        let input = Input::new(SharedString::from(format!("{prefix}-input")))
            .value(draft.text.clone())
            .placeholder(placeholder)
            .when(disabled, Input::disabled)
            .when(draft.invalid, Input::invalid)
            .on_change(move |text, _, cx| {
                let text = text.to_owned();
                let _ = page.update(cx, |this, cx| {
                    let draft = this.draft_mut(list);
                    draft.text = text;
                    draft.invalid = false;
                    cx.notify();
                });
            });
        let entry = div()
            .id(SharedString::from(format!("{prefix}-entry")))
            .capture_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "enter"
                    && !this.busy
                    && !this.draft(list).text.trim().is_empty()
                {
                    cx.stop_propagation();
                    this.add_host(list, cx);
                }
            }))
            .child(input);
        let add = Button::new(SharedString::from(format!("{prefix}-add")))
            .size(Size::Lg)
            .variant(Variant::Outline)
            .icon_start(icon(Icon::Plus, IconSize::Sm, ds))
            .text(copy.add_host)
            .when(disabled || draft.text.trim().is_empty(), Button::disabled)
            .on_click(cx.listener(move |this, _, _, cx| this.add_host(list, cx)));
        // CARVE-OUT(focus-restore): React refocuses the input after a save; the DS Input has no
        // focus handle to set. The input's aria-label has no gpui slot either.
        let entry_row = Stack::row()
            .gap(Space::Sm)
            .cross(Cross::Center)
            .child(
                StackItem::new()
                    .grow()
                    .min_width(MinWidth::Zero)
                    .child(entry),
            )
            .child(add);
        let mut entry_column = Stack::new().gap(Space::Xs).child(entry_row);
        if draft.invalid {
            entry_column = entry_column.child(FieldError::new().errors([copy.invalid_host]));
        }
        entry_column
    }
}
