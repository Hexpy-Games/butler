//! `CanonTagManageDialog.tsx`: rename, recolor or delete one tag.
use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::blocks::tag_color_swatches::TagColorSwatches;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{Dialog, DialogContent, Size as DialogSize};
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::layout::Justify;
use butler_ds::ui::tag::LabelTone;
use butler_ds::ui::text::{self, Input};
use butler_shell_client::Error;
use gpui::{
    AnyElement, Context, Entity, EventEmitter, InteractiveElement as _, IntoElement, KeyDownEvent,
    ParentElement as _, Render, SharedString, Window, div,
};
use serde_json::Value;

use super::CanonTags;
use super::copy::words;
use super::tags::{label_tone, tag_color, write_failure};
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::{CanonOverview, CanonTag, CanonTagEditInput};

/// `TagAction`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TagAction {
    Rename,
    Color,
    Delete,
}

/// What the dialog tells its owner.
pub(super) enum TagManageEvent {
    Closed,
    /// The tag with this id is gone (`onDeleted`).
    Deleted(SharedString),
}

/// The longest tag name (`maxLength` of the name input).
const NAME_MAX: usize = 32;

pub(super) struct TagManage {
    tags: Entity<CanonTags>,
    tag: CanonTag,
    action: TagAction,
    name: SharedString,
    color: LabelTone,
    /// How many epics lose the tag, once read (delete only).
    count: Option<usize>,
    busy: bool,
}

impl EventEmitter<TagManageEvent> for TagManage {}

impl TagManage {
    pub(super) fn new(
        tags: Entity<CanonTags>,
        tag: CanonTag,
        action: TagAction,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut dialog = Self {
            name: tag.tag.name.clone().into(),
            color: label_tone(tag.tag.color),
            tags,
            tag,
            action,
            count: None,
            busy: false,
        };
        if action == TagAction::Delete {
            dialog.load_count(cx);
        }
        dialog
    }

    /// The delete dialog says how many epics lose the tag: the board's epics that carry it.
    fn load_count(&mut self, cx: &mut Context<Self>) {
        let (project, id) = (self.tag.project_id.clone(), self.tag.tag.id.clone());
        fetch(
            cx,
            move |client| async move { client.get_canon(&project).await },
            move |this, result: Result<CanonOverview, Error>, cx| match result {
                Ok(overview) => {
                    let plans = overview.plans.iter().flat_map(|plan| plan.works.iter());
                    let epics = overview.backlog.iter().chain(plans);
                    let carrying = epics.filter(|epic| epic.tags.iter().any(|tag| tag.id == id));
                    this.count = Some(carrying.count());
                }
                Err(error) => this.failed(&error, cx),
            },
        );
    }

    /// `canonWriteFailure`: a conflict reads the tags again.
    fn failed(&mut self, error: &Error, cx: &mut Context<Self>) {
        if write_failure(error, cx) {
            self.tags.update(cx, super::tags::CanonTags::refresh);
        }
    }

    fn missing(&self) -> bool {
        match self.action {
            TagAction::Delete => self.count.is_none(),
            _ => self.name.trim().is_empty(),
        }
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.missing() {
            return;
        }
        self.busy = true;
        cx.notify();
        let id = self.tag.tag.id.clone();
        if self.action == TagAction::Delete {
            fetch(
                cx,
                move |client| async move { client.delete_canon_tag(&id).await },
                |this, result: Result<Value, Error>, cx| this.finished(result, cx),
            );
            return;
        }
        let rename = self.action == TagAction::Rename;
        let input = CanonTagEditInput {
            expected_revision: self.tag.revision,
            name: rename.then(|| self.name.trim().to_owned()),
            color: (!rename).then(|| tag_color(self.color)),
        };
        let Ok(body) = serde_json::to_value(&input) else {
            self.busy = false;
            return;
        };
        fetch(
            cx,
            move |client| async move { client.edit_canon_tag(&id, &body).await },
            |this, result: Result<Value, Error>, cx| this.finished(result, cx),
        );
    }

    /// The write answered: success refreshes the tags and closes; a conflict closes too.
    fn finished(&mut self, result: Result<Value, Error>, cx: &mut Context<Self>) {
        self.busy = false;
        match result {
            Ok(_) => {
                if self.action == TagAction::Delete {
                    cx.emit(TagManageEvent::Deleted(self.tag.tag.id.clone().into()));
                }
                self.tags.update(cx, super::tags::CanonTags::refresh);
                cx.emit(TagManageEvent::Closed);
            }
            Err(error) => {
                self.failed(&error, cx);
                if matches!(error, Error::Http(409)) {
                    cx.emit(TagManageEvent::Closed);
                }
            }
        }
        cx.notify();
    }

    /// The body of a rename or a recolor.
    fn field(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let copy = &words(Ds::get(cx).lang()).tags;
        let id = ("canon-tag-name", cx.entity_id());
        let me = cx.entity().downgrade();
        match self.action {
            TagAction::Delete => None,
            TagAction::Rename => {
                let state = text::state(id, window, cx);
                let input =
                    Input::new(id)
                        .value(self.name.clone())
                        .on_change(move |text, _, cx| {
                            let kept: String = text.chars().take(NAME_MAX).collect();
                            if kept != text {
                                state.update(cx, |state, cx| state.emplace(&kept, cx));
                            }
                            let _ = me.update(cx, |this, cx| {
                                this.name = kept.into();
                                cx.notify();
                            });
                        });
                let submit = cx.listener(|this, event: &KeyDownEvent, _, cx| {
                    if event.keystroke.key == "enter" {
                        cx.stop_propagation();
                        this.submit(cx);
                    }
                });
                Some(
                    Field::new(("canon-tag-name-field", cx.entity_id()))
                        .child(FieldLabel::new().child(copy.name))
                        .child(div().capture_key_down(submit).child(input))
                        .into_any_element(),
                )
            }
            TagAction::Color => Some(
                TagColorSwatches::new(("canon-tag-color", cx.entity_id()), self.color)
                    .labels(|tone| {
                        let at = LabelTone::ALL.iter().position(|item| *item == tone);
                        let name = at.and_then(|at| copy.colors.get(at)).copied();
                        name.unwrap_or_default().into()
                    })
                    .on_value_change(move |tone, _, cx| {
                        let _ = me.update(cx, |this, cx| {
                            this.color = tone;
                            cx.notify();
                        });
                    })
                    .into_any_element(),
            ),
        }
    }

    fn footer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let deleting = self.action == TagAction::Delete;
        let cancel = Button::new("canon-tag-cancel")
            .size(Size::Sm)
            .variant(Variant::Ghost)
            .text(copy.cancel)
            .on_click(cx.listener(|_, _, _, cx| cx.emit(TagManageEvent::Closed)));
        let mut submit = Button::new("canon-tag-submit")
            .size(Size::Sm)
            .variant(if deleting {
                Variant::Destructive
            } else {
                Variant::Default
            })
            .text(if deleting {
                copy.tags.remove
            } else {
                copy.save
            })
            .on_click(cx.listener(|this, _, _, cx| this.submit(cx)));
        let mut cancel = cancel;
        if self.busy {
            cancel = cancel.disabled();
        }
        if self.busy || self.missing() {
            submit = submit.disabled();
        }
        button::container(Size::Sm)
            .justify(Justify::End)
            .child(cancel)
            .child(submit)
    }
}

impl Render for TagManage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let title = match self.action {
            TagAction::Delete => (copy.tags.delete_title)(&self.tag.tag.name),
            TagAction::Rename => copy.tags.rename.to_owned(),
            TagAction::Color => copy.tags.recolor.to_owned(),
        };
        let mut form = DialogForm::new(title).footer(self.footer(cx));
        if self.action == TagAction::Delete {
            form = form.description(match self.count {
                Some(count) => (copy.tags.delete_detail)(count),
                None => copy.tags.loading.to_owned(),
            });
        }
        let body = self.field(window, cx);
        let me = cx.entity().downgrade();
        let dialog = Dialog::new(("canon-tag-manage", cx.entity_id()), window, cx)
            .open(true)
            .on_open_change(move |open, _, cx| {
                if open {
                    return;
                }
                let _ = me.update(cx, |this, cx| {
                    if !this.busy {
                        cx.emit(TagManageEvent::Closed);
                    }
                });
            });
        dialog.content(
            DialogContent::new()
                .size(DialogSize::Sm)
                .child(form.children(body)),
            window,
            cx,
        )
    }
}
