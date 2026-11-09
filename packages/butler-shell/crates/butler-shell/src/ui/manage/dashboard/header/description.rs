//! `ProjectDescription`: the project's introduction line and the dialog that edits it.
use butler_ds::ui::Icon;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, Space, Stack, WithItem as _};
use butler_ds::ui::text::Textarea;
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use butler_shell_client::Error;
use gpui::{
    Context, IntoElement, ParentElement as _, Render, SharedString, Window,
    prelude::FluentBuilder as _,
};
use serde_json::{Value, json};

use crate::ui::manage::dashboard::copy::words;
use crate::ui::manage::dashboard::state::Refresh;
use crate::ui::source::fetch::fetch;

/// React's `maxLength` of the description field.
const MAX_CHARS: usize = 2000;

pub(in crate::ui::manage::dashboard) struct ProjectDescription {
    project: SharedString,
    description: Option<String>,
    revision: i64,
    updated: Refresh,
    open: bool,
    draft: String,
    saving: bool,
}

impl ProjectDescription {
    pub(in crate::ui::manage::dashboard) fn new(project: SharedString, updated: Refresh) -> Self {
        Self {
            project,
            description: None,
            revision: 0,
            updated,
            open: false,
            draft: String::new(),
            saving: false,
        }
    }

    /// The dashboard's `description` and `preferences.revision`.
    pub(in crate::ui::manage::dashboard) fn set(
        &mut self,
        description: Option<String>,
        revision: i64,
        cx: &mut Context<Self>,
    ) {
        if self.description != description || self.revision != revision {
            self.description = description;
            self.revision = revision;
            cx.notify();
        }
    }

    /// `save`: PATCH the preferences at the revision they were read at.
    fn save(&mut self, cx: &mut Context<Self>) {
        self.saving = true;
        cx.notify();
        let project = self.project.to_string();
        let body = json!({ "expectedRevision": self.revision, "description": self.draft });
        fetch(
            cx,
            move |client| async move {
                client
                    .update_project_dashboard_preferences(&project, &body)
                    .await
            },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.saving = false;
                if result.is_ok() {
                    this.open = false;
                    (this.updated)(cx);
                } else {
                    let copy = words(Ds::get(cx).lang());
                    toast::show(cx, Toast::error(copy.dashboard_retry));
                }
            },
        );
    }

    fn dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let copy = words(Ds::get(cx).lang());
        let me = cx.entity();
        let dismiss = me.clone();
        let dialog = Dialog::new("project-description-dialog", window, cx)
            .open(true)
            .on_open_change(move |open, _, cx| {
                if !open {
                    dismiss.update(cx, |this, cx| {
                        this.open = false;
                        cx.notify();
                    });
                }
            });
        let typed = me.clone();
        // CARVE-OUT(G-ds): Textarea has no `max_length`; the draft is cut at 2000 characters.
        let input = Textarea::new("project-description-input")
            .default_value(self.draft.clone())
            .on_change(move |text, _, cx| {
                typed.update(cx, |this, _| {
                    this.draft = text.chars().take(MAX_CHARS).collect();
                });
            });
        let cancel = me.clone();
        let cancel = Button::new("project-description-cancel")
            .size(Size::Sm)
            .variant(Variant::Borderless)
            .text(copy.cancel)
            .on_click(move |_, _, cx| {
                cancel.update(cx, |this, cx| {
                    this.open = false;
                    cx.notify();
                });
            });
        let save = Button::new("project-description-save")
            .size(Size::Sm)
            .text(copy.save)
            .when(self.saving, Button::disabled)
            .on_click(move |_, _, cx| me.update(cx, Self::save));
        let content = DialogContent::new()
            .header(DialogHeader::new().child(DialogTitle::new(copy.description)))
            .child(input)
            .footer(DialogFooter::new().child(cancel).child(save));
        dialog.content(content, window, cx)
    }
}

impl Render for ProjectDescription {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let text = self
            .description
            .clone()
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| copy.description.to_owned());
        let edit = IconButton::new("project-description-edit", copy.edit_description)
            .glyph(Icon::Pencil)
            .on_click(cx.listener(|this, _, _, cx| {
                this.draft = this.description.clone().unwrap_or_default();
                this.open = true;
                cx.notify();
            }));
        let row = Stack::row()
            .cross(Cross::Start)
            .gap(Space::Sm)
            .child(
                Typo::body(text)
                    .tone(Tone::Secondary)
                    .wrap(Wrap::Anywhere)
                    .align_with_control()
                    .grow(),
            )
            .child(edit);
        let dialog = self.open.then(|| self.dialog(window, cx));
        Stack::new().gap(Space::Sm).child(row).children(dialog)
    }
}
