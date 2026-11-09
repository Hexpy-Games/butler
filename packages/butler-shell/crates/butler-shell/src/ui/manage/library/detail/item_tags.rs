//! `library/ItemTagsDialog.tsx`: the tags of one item, or of several at once (the tags on only
//! some of them can be put on, or taken off, all).
use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::blocks::tag_field::{Suggestion, TagField};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, ClickEvent, Context, EventEmitter, IntoElement, ParentElement as _, Render,
    SharedString, Window,
};

use super::api::{ItemsPatch, load_tags, patch_items};
use super::copy::words;
use super::dialogs::{DialogEvent, footer, shell};
use crate::ui::manage::ManageCtx;
use crate::ui::manage::library::types::{LibraryItem, TagCount};

pub(super) struct ItemTags {
    items: Vec<LibraryItem>,
    suggestions: Vec<TagCount>,
    /// The tags every item carries.
    common: Vec<String>,
    value: Vec<SharedString>,
    /// Tags to take off all items (the ones only some carried).
    remove: Vec<SharedString>,
    busy: bool,
}

impl EventEmitter<DialogEvent> for ItemTags {}

impl ItemTags {
    pub(super) fn new(_ctx: ManageCtx, items: Vec<LibraryItem>, cx: &mut Context<Self>) -> Self {
        load_tags(cx, |this: &mut Self, tags, _| {
            let changed = this.suggestions != tags;
            this.suggestions = tags;
            changed
        });
        let common: Vec<String> = items
            .first()
            .and_then(|item| item.tags.clone())
            .unwrap_or_default()
            .into_iter()
            .filter(|tag| items.iter().all(|item| has(item, tag)))
            .collect();
        Self {
            value: common.iter().cloned().map(SharedString::from).collect(),
            common,
            items,
            suggestions: Vec::new(),
            remove: Vec::new(),
            busy: false,
        }
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        self.busy = true;
        cx.notify();
        let mut remove: Vec<String> = self.remove.iter().map(ToString::to_string).collect();
        for tag in &self.common {
            if !self.value.iter().any(|v| **v == **tag) && !remove.contains(tag) {
                remove.push(tag.clone());
            }
        }
        let patch = ItemsPatch {
            ids: self.items.iter().map(|item| item.id.clone()).collect(),
            add_tags: Some(self.value.iter().map(ToString::to_string).collect()),
            remove_tags: Some(remove),
            ..ItemsPatch::default()
        };
        let me = cx.weak_entity();
        patch_items(cx, patch, move |result, cx| {
            let _ = me.update(cx, |this, cx| {
                this.busy = false;
                if result.is_ok() {
                    cx.emit(DialogEvent::Closed);
                } else {
                    let failed = words(Ds::get(cx).lang()).failed;
                    toast::show(cx, Toast::error(failed));
                }
                cx.notify();
            });
        });
    }

    /// The tags only some of the items carry, each with a way to settle it for all.
    fn partial(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let copy = words(Ds::get(cx).lang());
        let total = i64::try_from(self.items.len()).unwrap_or(i64::MAX);
        let mut all: Vec<&String> = Vec::new();
        for tag in self
            .items
            .iter()
            .flat_map(|item| item.tags.iter().flatten())
        {
            if !all.contains(&tag) {
                all.push(tag);
            }
        }
        let mut rows = Vec::new();
        for tag in all {
            if self.common.contains(tag) || self.remove.iter().any(|r| **r == **tag) {
                continue;
            }
            let count = self.items.iter().filter(|item| has(item, tag)).count();
            let count = i64::try_from(count).unwrap_or(i64::MAX);
            let (add_tag, remove_tag) = (
                SharedString::from(tag.clone()),
                SharedString::from(tag.clone()),
            );
            let add = Button::new(SharedString::from(format!("library-tags-all-{tag}")))
                .size(Size::Xs)
                .variant(Variant::Ghost)
                .text(copy.add_to_all)
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    if !this.value.contains(&add_tag) {
                        this.value.push(add_tag.clone());
                    }
                    cx.notify();
                }));
            let remove = Button::new(SharedString::from(format!("library-tags-none-{tag}")))
                .size(Size::Xs)
                .variant(Variant::Ghost)
                .text(copy.remove_from_all)
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.remove.push(remove_tag.clone());
                    this.value.retain(|v| *v != remove_tag);
                    cx.notify();
                }));
            rows.push(
                Stack::row()
                    .cross(Cross::Center)
                    .gap(Space::Sm)
                    .wrap(true)
                    .child(Typo::text(tag.clone()))
                    .child(Typo::caption((copy.tags_on_some)(count, total)).tone(Tone::Tertiary))
                    .child(button::container(Size::Xs).child(add).child(remove))
                    .into_any_element(),
            );
        }
        rows
    }
}

fn has(item: &LibraryItem, tag: &str) -> bool {
    item.tags.iter().flatten().any(|own| own == tag)
}

impl Render for ItemTags {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let me = cx.weak_entity();
        let suggestions: Vec<Suggestion> = self
            .suggestions
            .iter()
            .map(|tag| {
                Suggestion::new(tag.name.clone()).count(u32::try_from(tag.count).unwrap_or(0))
            })
            .collect();
        let field = TagField::new(("library-item-tags", cx.entity_id()), copy.tags)
            .value(self.value.clone(), move |next, _, cx| {
                let _ = me.update(cx, |this, cx| {
                    this.remove.retain(|tag| !next.contains(tag));
                    this.value = next;
                    cx.notify();
                });
            })
            .suggestions(suggestions)
            .placeholder(copy.add_tag)
            .remove_label(move |name| (copy.remove_tag)(name).into())
            .create_label(move |name| (copy.create_tag)(name).into());
        let mut body = vec![field.into_any_element()];
        if self.items.len() > 1 {
            body.extend(self.partial(cx));
        }
        let count = i64::try_from(self.items.len()).unwrap_or(i64::MAX);
        let cancel = cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(DialogEvent::Closed));
        let save = cx.listener(|this, _: &ClickEvent, _, cx| this.submit(cx));
        let form = DialogForm::new((copy.bulk_tags_title)(count))
            .footer(footer(
                "library-item-tags",
                (copy.cancel, cancel),
                (copy.save, save),
                self.busy,
                false,
            ))
            .child(Stack::new().gap(Space::Md).children(body));
        let me = cx.weak_entity();
        shell(
            ("library-item-tags-dialog", cx.entity_id()),
            form,
            self.busy,
            move |_, cx| {
                let _ = me.update(cx, |_, cx| cx.emit(DialogEvent::Closed));
            },
            window,
            cx,
        )
    }
}
