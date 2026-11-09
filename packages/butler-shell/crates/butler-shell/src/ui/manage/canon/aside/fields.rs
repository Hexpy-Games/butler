//! `EpicInlineFields.tsx` and `EpicFieldInput.tsx`: the epic's title and description, each a
//! click to edit in place with save (✓), cancel (×), the attach button and the conflict note.
use std::collections::HashSet;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::attachment_list::{AttachmentItem, AttachmentList, Upload};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::clickable::{Bleed, Clickable};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::text::{self, Input, Textarea};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::{Typo, Weight, Wrap};
use gpui::{
    AnyElement, Context, Focusable as _, InteractiveElement as _, IntoElement as _,
    ParentElement as _, SharedString, Styled as _, Window, div,
};

use super::attach::{self, AttachedFile, UploadError};
use super::copy::Words;
use super::guard::TextField;
use super::inspector::EpicInspector;
use crate::ui::source::wire::EpicDetail;

impl TextField {
    fn id(self) -> &'static str {
        match self {
            Self::Title => "canon-inline-title",
            Self::Description => "canon-inline-description",
        }
    }
}

impl EpicInspector {
    /// `EpicInlineFields`: `action` sits beside the title, `summary` under it.
    pub(super) fn inline_fields(
        &mut self,
        epic: &EpicDetail,
        compact: bool,
        action: AnyElement,
        summary: AnyElement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if std::mem::take(&mut self.inline.refocus)
            && let Some(field) = self.inline.draft.as_ref().map(|draft| draft.field)
        {
            let editor = text::state(field.id(), window, cx);
            let handle = editor.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
        }
        let (mut action, mut summary) = (Some(action), Some(summary));
        let editing = self.inline.draft.as_ref().map(|draft| draft.field);
        let referenced = attach::references(&epic.card.description);
        let loose: Vec<AttachmentItem> = epic
            .attachments
            .iter()
            .flatten()
            .filter(|file| !referenced.contains(&file.file_id))
            .map(|file| AttachmentItem::new(file.file_id.clone(), file.safe_name.clone()))
            .collect();
        let mut fields = Stack::new().gap(Space::Lg);
        for field in [TextField::Title, TextField::Description] {
            let body = if editing == Some(field) {
                self.field_input(epic, field, cx)
            } else {
                self.field_rest(epic, field, compact, cx)
            };
            let mut row = Stack::row()
                .gap(Space::Lg)
                .cross(Cross::Start)
                .child(div().flex_1().min_w_0().child(body));
            let mut column = Stack::new().gap(Space::Sm);
            if field == TextField::Title {
                row = row.children(action.take().map(|a| div().flex_none().child(a)));
                column = column.child(row).children(summary.take());
            } else {
                column = column.child(row);
                if editing != Some(field) && !loose.is_empty() {
                    column = column.child(AttachmentList::new("canon-loose-files", loose.clone()));
                }
            }
            fields = fields.child(column);
        }
        fields.into_any_element()
    }

    /// `EpicFieldRest`
    fn field_rest(
        &self,
        epic: &EpicDetail,
        field: TextField,
        compact: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = Self::words(cx);
        let value = field.of(epic).to_owned();
        let body: AnyElement = match field {
            TextField::Title if compact => Typo::body(value)
                .weight(Weight::Medium)
                .wrap(Wrap::Anywhere)
                .into_any_element(),
            TextField::Title => Typo::panel_title(value)
                .wrap(Wrap::Anywhere)
                .into_any_element(),
            TextField::Description if value.is_empty() => {
                Typo::caption(words.description_placeholder).into_any_element()
            }
            TextField::Description => {
                attach::markdown("canon-epic-description", &value, &attached(epic), true, cx)
            }
        };
        let group = SharedString::from(format!("{}-rest", field.id()));
        // ANIM-MIGRATE(the pencil fades in on hover and focus): shown at once on hover.
        let pencil = div()
            .flex_none()
            .opacity(0.)
            .group_hover_style(group.clone(), |style| style.opacity(1.))
            .child(icon(Icon::Pencil, IconSize::Sm, Ds::get(cx)));
        let label = match field {
            TextField::Title => words.edit_title,
            TextField::Description => words.edit_description,
        };
        let mut trigger =
            Clickable::new(SharedString::from(format!("{}-rest-trigger", field.id())))
                .bleed(Bleed::Both)
                .stretch()
                .on_click(
                    cx.listener(move |this, _, window, cx| this.begin_edit(field, window, cx)),
                )
                .child(
                    Stack::row()
                        .gap(Space::Xs)
                        .cross(if field == TextField::Title {
                            Cross::Center
                        } else {
                            Cross::Start
                        })
                        .child(div().flex_1().min_w_0().child(body))
                        .child(pencil),
                );
        if self.busy || self.inline.uploading.is_some() {
            trigger = trigger.disabled();
        }
        Tooltip::new(SharedString::from(format!("{}-rest-tip", field.id())))
            .label(label)
            .child(div().group(group).child(trigger))
            .into_any_element()
    }

    /// `EpicFieldInput`
    fn field_input(
        &self,
        epic: &EpicDetail,
        field: TextField,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = Self::words(cx);
        let Some(draft) = self.inline.draft.as_ref() else {
            return div().into_any_element();
        };
        let saving = self.busy || self.inline.uploading.is_some();
        let multiline = field == TextField::Description;
        let me = cx.weak_entity();
        let change = move |text: &str, _: &mut Window, cx: &mut gpui::App| {
            let value = text.to_owned();
            let _ = me.update(cx, |this, cx| this.change_edit(value, cx));
        };
        let actions = self.field_actions(saving, cx);
        let editor: AnyElement = if multiline {
            let mut area = Textarea::new(field.id())
                .auto_grow()
                .value(draft.value.clone())
                .on_change(change);
            if saving {
                area = area.disabled();
            }
            let attach_control = self.attach_button(epic, saving, cx);
            Stack::new()
                .gap(Space::Sm)
                .child(area)
                .child(
                    Stack::row()
                        .justify(Justify::Between)
                        .cross(Cross::Center)
                        .gap(Space::Xs)
                        .child(attach_control)
                        .child(actions),
                )
                .children(self.input_files(epic, &draft.value))
                .into_any_element()
        } else {
            let mut input = Input::new(field.id())
                .value(draft.value.clone())
                .on_change(change);
            if saving {
                input = input.disabled();
            }
            Stack::row()
                .gap(Space::Xs)
                .cross(Cross::Center)
                .child(div().flex_1().min_w_0().child(input))
                .child(actions)
                .into_any_element()
        };
        let conflict = draft
            .current
            .as_ref()
            .map(|current| conflict_note(current, &draft.base, field, words));
        let keys = Self::edit_keys(multiline, cx);
        div()
            .on_key_down(keys)
            .child(Stack::new().gap(Space::Sm).child(editor).children(conflict))
            .into_any_element()
    }

    /// Escape cancels, Enter (or mod+Enter in the description) saves.
    fn edit_keys(
        multiline: bool,
        cx: &mut Context<Self>,
    ) -> impl Fn(&gpui::KeyDownEvent, &mut Window, &mut gpui::App) + 'static {
        cx.listener(move |this, event: &gpui::KeyDownEvent, _, cx| {
            let saving = this.busy || this.inline.uploading.is_some();
            let key = event.keystroke.key.as_str();
            if key == "escape" {
                cx.stop_propagation();
                if !saving {
                    this.cancel_edit(cx);
                }
            } else if key == "enter" && (!multiline || event.keystroke.modifiers.secondary()) {
                cx.stop_propagation();
                if !saving {
                    this.save_edit(None, cx);
                }
            }
        })
    }

    /// The cancel (×) and save (✓) buttons.
    fn field_actions(&self, saving: bool, cx: &mut Context<Self>) -> AnyElement {
        let words = Self::words(cx);
        let ds = Ds::get(cx);
        let mark = |glyph: Icon| icon(glyph, IconSize::Sm, ds);
        let mut cancel = Button::new("canon-inline-cancel")
            .size(Size::IconSm)
            .variant(Variant::Outline)
            .icon_start(mark(Icon::XIcon))
            .on_click(cx.listener(|this, _, _, cx| this.cancel_edit(cx)));
        let mut save = Button::new("canon-inline-save")
            .size(Size::IconSm)
            .icon_start(mark(Icon::CheckIcon))
            .on_click(cx.listener(|this, _, _, cx| this.save_edit(None, cx)));
        if saving {
            cancel = cancel.disabled();
        }
        if saving || !self.inline.valid() {
            save = save.disabled();
        }
        let tip = |id: &'static str, label: &'static str, child: Button| {
            Tooltip::new(id).label(label).child(child)
        };
        button::container(Size::IconSm)
            .justify(Justify::End)
            .child(tip("canon-inline-cancel-tip", words.cancel, cancel))
            .child(tip("canon-inline-save-tip", words.save, save))
            .into_any_element()
    }

    /// The attach button of `useEpicAttachments`.
    fn attach_button(&self, epic: &EpicDetail, saving: bool, cx: &mut Context<Self>) -> AnyElement {
        let words = Self::words(cx);
        let uploading = self.inline.uploading.is_some();
        let project = SharedString::from(epic.card.project_id.clone());
        let mut button = Button::new("canon-inline-attach")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(words.attach_file)
            .on_click(cx.listener(move |_, _, _, cx| {
                attach::pick_and_upload(
                    project.clone(),
                    cx,
                    |this: &mut Self, name, cx| {
                        this.inline.uploading = Some(name);
                        cx.notify();
                    },
                    |this: &mut Self, result, cx| this.attached(result, cx),
                );
            }));
        if saving || uploading {
            button = button.disabled();
        }
        let reason = if uploading {
            Some(words.uploading_file)
        } else if saving {
            Some(words.saving)
        } else {
            None
        };
        let tip = Tooltip::new("canon-inline-attach-tip").wrap().child(button);
        button::container(Size::Sm)
            .child(match reason {
                Some(reason) => tip.label(reason),
                None => tip,
            })
            .into_any_element()
    }

    /// `upload`'s end: the reference joins the description, or the owner is told why not.
    fn attached(&mut self, result: Result<AttachedFile, UploadError>, cx: &mut Context<Self>) {
        self.inline.uploading = None;
        let words = Self::words(cx);
        match result {
            Ok(file) => {
                // CARVE-OUT(G-ds): the editor's caret is not readable, so the reference goes at
                // the end of the text, where React's goes with no selection.
                if let Some(value) = self.inline.draft.as_ref().map(|d| d.value.clone()) {
                    self.change_edit(format!("{value}{}", file.reference()), cx);
                }
                self.inline.files.push(file);
            }
            Err(UploadError::TooLarge) => {
                toast::show(cx, Toast::error(words.file_too_large));
            }
            Err(UploadError::Failed) => {
                toast::show(cx, Toast::error(words.upload_failed));
            }
        }
        cx.notify();
    }

    /// The attachment list under the description editor: the files its text names, and the one
    /// being uploaded.
    fn input_files(&self, epic: &EpicDetail, value: &str) -> Option<AnyElement> {
        let named: HashSet<String> = attach::references(value);
        let mut files: Vec<AttachedFile> = Vec::new();
        for file in epic
            .attachments
            .iter()
            .flatten()
            .map(AttachedFile::from)
            .chain(self.inline.files.iter().cloned())
        {
            match files.iter_mut().find(|known| known.file_id == file.file_id) {
                Some(known) => *known = file,
                None => files.push(file),
            }
        }
        let mut items: Vec<AttachmentItem> = files
            .into_iter()
            .filter(|file| named.contains(&file.file_id))
            .map(|file| AttachmentItem::new(file.file_id, file.safe_name))
            .collect();
        if let Some(name) = self.inline.uploading.clone() {
            items.push(AttachmentItem::new("upload", name).upload(Upload::Uploading));
        }
        (!items.is_empty())
            .then(|| AttachmentList::new("canon-edit-files", items).into_any_element())
    }
}

/// The epic's stored files as the description names them.
fn attached(epic: &EpicDetail) -> Vec<AttachedFile> {
    epic.attachments
        .iter()
        .flatten()
        .map(AttachedFile::from)
        .collect()
}

/// The epic as someone else saved it, for the fields that differ (and the one being edited).
fn conflict_note(
    current: &EpicDetail,
    base: &EpicDetail,
    field: TextField,
    words: &Words,
) -> Stack {
    let mut note = Stack::new()
        .gap(Space::Xs)
        .child(Typo::caption(words.current));
    for key in [TextField::Title, TextField::Description] {
        if key == field || key.of(current) != key.of(base) {
            let shown = Some(key.of(current)).filter(|text| !text.is_empty());
            let label = if key == TextField::Title {
                words.title
            } else {
                words.description
            };
            note = note.child(
                Typo::caption(format!(
                    "{label}: {}",
                    shown.unwrap_or(words.no_description)
                ))
                .wrap(Wrap::Pre),
            );
        }
    }
    note
}
