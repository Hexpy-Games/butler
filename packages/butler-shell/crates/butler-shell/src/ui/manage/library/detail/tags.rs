//! `library/ManageTagsDialog.tsx`: every tag with its count; rename (onto an existing tag merges
//! them) or delete.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::blocks::tag_field::tag_key;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::scroll::{MaxHeight, ScrollArea};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::Error;
use gpui::{
    App, ClickEvent, Context, EventEmitter, IntoElement, ParentElement as _, Render, SharedString,
    Subscription, Window,
};
use serde_json::Value;

use super::api::{delete_tag, load_tags, rename_tag};
use super::copy::{Words, words};
use super::dialogs::{DialogEvent, shell, text_field};
use crate::ui::manage::library::types::TagCount;
use crate::ui::manage::{ManageCtx, Topic};

/// `maxLength` of a tag's name field.
const NAME_MAX: usize = 40;

pub(super) struct ManageTags {
    tags: Vec<TagCount>,
    revision: u64,
    /// The tag whose row is the rename form, and the name typed into it.
    editing: Option<String>,
    name: SharedString,
    busy: bool,
    _live: Subscription,
}

impl EventEmitter<DialogEvent> for ManageTags {}

impl ManageTags {
    pub(super) fn new(ctx: &ManageCtx, cx: &mut Context<Self>) -> Self {
        let revision = ctx.live.read(cx).revision(&Topic::Library);
        let live = cx.observe(&ctx.live, |this, live, cx| {
            let moved = live.read(cx).revision(&Topic::Library);
            if std::mem::replace(&mut this.revision, moved) != moved {
                Self::reload(cx);
            }
        });
        let dialog = Self {
            tags: Vec::new(),
            revision,
            editing: None,
            name: SharedString::default(),
            busy: false,
            _live: live,
        };
        Self::reload(cx);
        dialog
    }

    fn reload(cx: &mut Context<Self>) {
        load_tags(cx, |this: &mut Self, tags, _| {
            let changed = this.tags != tags;
            this.tags = tags;
            changed
        });
    }

    /// The other tag the typed name collides with: renaming onto it merges.
    fn merge_target(&self, tag: &str) -> Option<&TagCount> {
        let wanted = tag_key(&self.name);
        self.tags
            .iter()
            .find(|other| other.name != tag && tag_key(&other.name) == wanted)
    }

    fn mutate(&mut self, tag: String, remove: bool, cx: &mut Context<Self>) {
        self.busy = true;
        cx.notify();
        let name = self.name.trim().to_owned();
        let to = (!remove).then(|| {
            self.merge_target(&tag)
                .map_or_else(|| name.clone(), |target| target.name.clone())
        });
        let (me, from) = (cx.weak_entity(), tag.clone());
        let done = move |result: Result<Value, Error>, cx: &mut App| {
            let _ = me.update(cx, |this, cx| this.mutated(from, to, result.is_ok(), cx));
        };
        if remove {
            delete_tag(cx, tag, done);
        } else {
            rename_tag(cx, &tag, &name, done);
        }
    }

    fn mutated(&mut self, from: String, to: Option<String>, ok: bool, cx: &mut Context<Self>) {
        self.busy = false;
        if ok {
            self.editing = None;
            cx.emit(DialogEvent::TagChanged {
                from: from.into(),
                to: to.map(Into::into),
            });
        } else {
            let failed = words(Ds::get(cx).lang()).failed;
            toast::show(cx, Toast::error(failed));
        }
        cx.notify();
    }

    fn view_row(tag: &TagCount, copy: &Words, cx: &mut Context<Self>) -> gpui::AnyElement {
        let ds = Ds::get(cx);
        let (rename, delete) = (tag.name.clone(), tag.name.clone());
        let menu = OverflowActionMenu::new(
            SharedString::from(format!("library-tag-menu-{}", tag.name)),
            copy.more,
        )
        .item(
            OverflowItem::new(copy.rename)
                .icon(Icon::PencilLine)
                .on_select({
                    let me = cx.weak_entity();
                    move |_, cx| {
                        let (me, tag) = (me.clone(), rename.clone());
                        let _ = me.update(cx, |this, cx| {
                            this.name = tag.clone().into();
                            this.editing = Some(tag);
                            cx.notify();
                        });
                    }
                }),
        )
        .item(
            OverflowItem::new(copy.delete_tag)
                .icon(Icon::Trash2)
                .destructive()
                .on_select({
                    let me = cx.weak_entity();
                    move |_, cx| {
                        let (me, tag) = (me.clone(), delete.clone());
                        let _ = me.update(cx, |this, cx| this.mutate(tag, true, cx));
                    }
                }),
        );
        let label = Stack::row()
            .cross(Cross::Center)
            .gap(Space::Sm)
            .child(icon(Icon::TagIcon, IconSize::Sm, ds))
            .child(Typo::text(tag.name.clone()))
            .child(Typo::caption(tag.count.to_string()).tone(Tone::Tertiary));
        Stack::row()
            .cross(Cross::Center)
            .justify(Justify::Between)
            .gap(Space::Sm)
            .child(label)
            .child(menu)
            .into_any_element()
    }

    /// Cancel, save (or merge) and delete of the rename form; busy locks them.
    fn edit_actions(
        &self,
        tag: &TagCount,
        copy: &Words,
        merging: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let unchanged = self.name.trim().is_empty() || *self.name == *tag.name;
        let (cancel_tag, save_tag, delete_tag) =
            (tag.name.clone(), tag.name.clone(), tag.name.clone());
        let mut cancel = Button::new(SharedString::from(format!(
            "library-tag-cancel-{}",
            tag.name
        )))
        .size(Size::Sm)
        .variant(Variant::Ghost)
        .text(copy.cancel)
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            this.name = cancel_tag.clone().into();
            this.editing = None;
            cx.notify();
        }));
        let mut save = Button::new(SharedString::from(format!("library-tag-save-{}", tag.name)))
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(if merging { copy.merge } else { copy.rename })
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.mutate(save_tag.clone(), false, cx);
            }));
        let mut remove = Button::new(SharedString::from(format!(
            "library-tag-remove-{}",
            tag.name
        )))
        .size(Size::Sm)
        .variant(Variant::Ghost)
        .text(copy.delete_tag)
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            this.mutate(delete_tag.clone(), true, cx);
        }));
        if self.busy {
            cancel = cancel.disabled();
            remove = remove.disabled();
        }
        if self.busy || unchanged {
            save = save.disabled();
        }
        button::container(Size::Sm)
            .child(cancel)
            .child(save)
            .child(remove)
    }

    fn edit_row(
        &self,
        tag: &TagCount,
        copy: &Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let me = cx.weak_entity();
        let input = text_field(
            SharedString::from(format!("library-tag-name-{}", tag.name)),
            &self.name,
            NAME_MAX,
            window,
            cx,
            move |name, cx| {
                let _ = me.update(cx, |this, cx| {
                    this.name = name;
                    cx.notify();
                });
            },
        );
        let target = self.merge_target(&tag.name);
        let actions = self.edit_actions(tag, copy, target.is_some(), cx);
        let note = target.map(|other| {
            Typo::caption((copy.merge_note)(
                &tag.name,
                tag.count,
                &other.name,
                other.count,
            ))
        });
        Stack::new()
            .gap(Space::Xs)
            .child(
                Stack::row()
                    .cross(Cross::Center)
                    .gap(Space::Sm)
                    .wrap(true)
                    .child(input)
                    .child(Typo::caption(tag.count.to_string()))
                    .child(actions),
            )
            .children(note)
            .into_any_element()
    }
}

impl Render for ManageTags {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let tags = self.tags.clone();
        let mut rows = Vec::new();
        for tag in &tags {
            rows.push(if self.editing.as_deref() == Some(tag.name.as_str()) {
                self.edit_row(tag, copy, window, cx)
            } else {
                Self::view_row(tag, copy, cx)
            });
        }
        if tags.is_empty() {
            rows.push(EmptyLine::new(copy.no_tags).into_any_element());
        }
        let list = ScrollArea::new("library-tags-scroll")
            .max_height(MaxHeight::Sm)
            .child(Stack::new().gap(Space::Md).children(rows));
        let form = DialogForm::new(copy.manage_tags).child(list);
        let me = cx.weak_entity();
        shell(
            ("library-tags-dialog", cx.entity_id()),
            form,
            false,
            move |_, cx| {
                let _ = me.update(cx, |_, cx| cx.emit(DialogEvent::Closed));
            },
            window,
            cx,
        )
    }
}
