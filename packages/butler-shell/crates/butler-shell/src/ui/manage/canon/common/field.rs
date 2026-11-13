//! `CanonTagsField.tsx`: the tags of one epic or draft, with the chooser, create and manage.
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::layout::{Space, Stack};
use gpui::AppContext as _;
use gpui::{
    Context, Entity, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Subscription, Window, div,
};

use super::chooser::{Props, chooser};
use super::copy::words;
use super::editor::{TagEditor, TagEditorEvent};
use super::manage::TagAction;
use super::tags::tag_list;
use super::{CanonTags, OnTags, RemoveTag};
use crate::ui::manage::{ManageCtx, Pick};
use crate::ui::source::wire::{CanonTag, EpicTag};
use crate::ui::widgets::anchor;

/// `CanonTagsField`. `value` holds tag ids; a field built with `row` is a property row, whose
/// chips are the chooser's trigger.
pub(crate) struct TagsField {
    value: Vec<SharedString>,
    on_change: OnTags,
    disabled: bool,
    row: bool,
    tags: Entity<CanonTags>,
    editor: Entity<TagEditor>,
    _editor: Subscription,
    _events: Subscription,
    _tags: Subscription,
}

impl TagsField {
    #[expect(clippy::too_many_arguments, reason = "CanonTagsField's props")]
    pub(crate) fn new(
        ctx: &ManageCtx,
        project: SharedString,
        value: Vec<SharedString>,
        on_change: OnTags,
        disabled: bool,
        row: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let tags = cx.new(|cx| CanonTags::new(project, &ctx.live, cx));
        let subscription = cx.observe(&tags, |_, _, cx| cx.notify());
        let editor = cx.new(|_| TagEditor::new(tags.clone()));
        let observe = cx.observe(&editor, |_, _, cx| cx.notify());
        let events = cx.subscribe_in(&editor, window, |this, _, event, window, cx| match event {
            TagEditorEvent::Created(tag) => {
                let id = SharedString::from(tag.tag.id.clone());
                let mut ids: Vec<_> = this
                    .value
                    .iter()
                    .filter(|item| **item != id)
                    .cloned()
                    .collect();
                ids.push(id);
                this.change(ids, window, cx);
            }
            TagEditorEvent::Deleted(id) if !this.row => {
                let ids = this
                    .value
                    .iter()
                    .filter(|item| *item != id)
                    .cloned()
                    .collect();
                this.change(ids, window, cx);
            }
            TagEditorEvent::Deleted(_) => {}
        });
        Self {
            value,
            on_change,
            disabled,
            row,
            tags,
            editor,
            _editor: observe,
            _events: events,
            _tags: subscription,
        }
    }

    /// The owner's own change of the chosen tags.
    pub(crate) fn set_value(&mut self, value: Vec<SharedString>, cx: &mut Context<Self>) {
        if self.value != value {
            self.value = value;
            cx.notify();
        }
    }

    /// The owner's own change of `disabled`.
    pub(crate) fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        if self.disabled != disabled {
            self.disabled = disabled;
            cx.notify();
        }
    }

    fn change(&mut self, ids: Vec<SharedString>, window: &mut Window, cx: &mut Context<Self>) {
        self.value.clone_from(&ids);
        cx.notify();
        (self.on_change)(ids, window, cx);
    }

    /// The chooser's callbacks: change, create and manage.
    fn handlers(cx: &Context<Self>) -> (OnTags, Pick<SharedString>, Pick<(CanonTag, TagAction)>) {
        let me = cx.entity().downgrade();
        let on_change: OnTags = {
            let me = me.clone();
            std::rc::Rc::new(move |ids, window, cx| {
                let _ = me.update(cx, |this, cx| this.change(ids, window, cx));
            })
        };
        let on_create: Pick<SharedString> = {
            let me = me.clone();
            std::rc::Rc::new(move |name, window, cx| {
                let _ = me.update(cx, |this, cx| {
                    if !this.disabled {
                        this.editor
                            .update(cx, |editor, cx| editor.create(&name, window, cx));
                    }
                });
            })
        };
        let on_manage: Pick<(CanonTag, TagAction)> =
            std::rc::Rc::new(move |(tag, action), window, cx| {
                let _ = me.update(cx, |this, cx| {
                    this.editor
                        .update(cx, |editor, cx| editor.open(tag, action, window, cx));
                });
            });
        (on_change, on_create, on_manage)
    }

    /// The chip's remove button: drops the id from the chosen tags.
    fn remover(cx: &Context<Self>) -> RemoveTag {
        let me = cx.entity().downgrade();
        std::rc::Rc::new(
            move |id: &SharedString, window: &mut Window, cx: &mut gpui::App| {
                let id = id.clone();
                let _ = me.update(cx, |this, cx| {
                    let ids = this
                        .value
                        .iter()
                        .filter(|item| **item != id)
                        .cloned()
                        .collect();
                    this.change(ids, window, cx);
                });
            },
        )
    }

    /// The chosen tags, as the list holds them (an id the list does not know yet is left out).
    fn selected(&self, cx: &Context<Self>) -> Vec<EpicTag> {
        let tags = self.tags.read(cx).tags();
        self.value
            .iter()
            .filter_map(|id| tags.iter().find(|tag| tag.tag.id == **id))
            .map(|tag| tag.tag.clone())
            .collect()
    }
}

impl Render for TagsField {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let selected = self.selected(cx);
        let (on_change, on_create, on_manage) = Self::handlers(cx);
        let busy = self.disabled || self.editor.read(cx).busy();
        let chips = self.row.then(|| {
            if selected.is_empty() {
                div().child(copy.none).into_any_element()
            } else {
                tag_list(&selected, None, None, cx)
            }
        });
        let props = Props {
            id: ("canon-tags-chooser", cx.entity_id()).into(),
            tags: self.tags.read(cx).tags().to_vec(),
            value: self.value.clone(),
            on_change,
            on_create: Some(on_create),
            on_manage: Some(on_manage),
            disabled: busy,
            filter: false,
            chips,
            end: self.row,
        };
        let picker = chooser(props, window, cx);
        let dialog = self.editor.read(cx).dialog();
        if self.row {
            return anchor(div(), "canon-tags-field")
                .min_w_0()
                .flex_shrink_1()
                .child(picker)
                .children(dialog)
                .into_any_element();
        }
        let remove = (!busy).then(|| Self::remover(cx));
        anchor(div(), "canon-tags-field")
            .child(
                Field::new(("canon-tags-field-body", cx.entity_id()))
                    .child(FieldLabel::new().child(copy.tags.label))
                    .child(Stack::new().gap(Space::Xs).child(tag_list(
                        &selected,
                        None,
                        remove.as_ref(),
                        cx,
                    )))
                    .child(picker),
            )
            .children(dialog)
            .into_any_element()
    }
}
