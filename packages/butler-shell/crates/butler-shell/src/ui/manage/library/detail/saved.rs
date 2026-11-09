//! `library/SavedGroupChooser.tsx`: scraps just saved from the browser: put them in a group.
// CARVE-OUT(G-ds): React shows this as a Popover beside the sidebar's 서랍 row (`beside`) when
// the row is visible; the DS Popover has no virtual anchor, so it is always the dialog.
// CARVE-OUT(G-cef): React also raises the app window (`browserCall("focus-app")`).
use gpui::ParentElement as _;
use std::rc::Rc;

use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::scroll::{MaxHeight, ScrollArea};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::Typo;
use gpui::{App, ClickEvent, Context, EventEmitter, IntoElement, Render, SharedString, Window};

use super::api::{ItemsPatch, load_groups, patch_items};
use super::copy::words;
use super::dialogs::{DialogEvent, LibraryDialog, shell};
use super::runtime::open_dialog;
use crate::ui::manage::library::types::LibraryGroup;
use crate::ui::manage::{LibraryKind, ManageCtx};

pub(super) struct SavedChooser {
    ids: Vec<String>,
    groups: Vec<LibraryGroup>,
    busy: bool,
}

impl EventEmitter<DialogEvent> for SavedChooser {}

impl SavedChooser {
    pub(super) fn new(_ctx: ManageCtx, ids: Vec<String>, cx: &mut Context<Self>) -> Self {
        load_groups(cx, LibraryKind::Scrap, |this: &mut Self, groups, _| {
            this.groups = groups;
            true
        });
        Self {
            ids,
            groups: Vec::new(),
            busy: false,
        }
    }

    fn choose(&mut self, group: String, cx: &mut Context<Self>) {
        self.busy = true;
        cx.notify();
        let me = cx.weak_entity();
        file(self.ids.clone(), group, cx, move |ok, cx| {
            let _ = me.update(cx, |this, cx| {
                this.busy = false;
                if ok {
                    cx.emit(DialogEvent::Closed);
                }
                cx.notify();
            });
        });
    }

    /// The group button "New group": the group dialog creates it, then the scraps go in.
    fn new_group(&mut self, cx: &mut Context<Self>) {
        let ids = self.ids.clone();
        let then: crate::ui::manage::Pick<LibraryGroup> = Rc::new(move |group, _, cx| {
            file(ids.clone(), group.id, cx, |_, _| {});
        });
        open_dialog(
            LibraryDialog::CreateGroup {
                kind: LibraryKind::Scrap,
                then: Some(then),
            },
            cx,
        );
    }
}

/// `patchItems({ ids, group })`, with the failure toast.
fn file(
    ids: Vec<String>,
    group: String,
    cx: &mut App,
    done: impl FnOnce(bool, &mut App) + 'static,
) {
    let patch = ItemsPatch {
        ids,
        group: Some(Some(group)),
        ..ItemsPatch::default()
    };
    patch_items(cx, patch, move |result, cx| {
        let ok = result.is_ok();
        if !ok {
            toast::show(cx, Toast::error(words(Ds::get(cx).lang()).failed));
        }
        done(ok, cx);
    });
}

impl Render for SavedChooser {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let count = i64::try_from(self.ids.len()).unwrap_or(i64::MAX);
        let leave = Button::new("library-saved-leave")
            .variant(Variant::Ghost)
            .text(copy.leave_ungrouped)
            .on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(DialogEvent::Closed)));
        let mut rows = Vec::new();
        for group in &self.groups {
            let id = group.id.clone();
            let mut button = Button::new(SharedString::from(format!("library-saved-{}", group.id)))
                .variant(Variant::Ghost)
                .text(group.name.clone())
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.choose(id.clone(), cx);
                }));
            if self.busy {
                button = button.disabled();
            }
            rows.push(button);
        }
        let new = Button::new("library-saved-new")
            .variant(Variant::Ghost)
            .text(copy.group(LibraryKind::Scrap).new_group)
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.new_group(cx)));
        let body = Stack::new()
            .gap(Space::Sm)
            .child(Typo::text((copy.saved_scraps)(count)))
            .child(if self.busy { leave.disabled() } else { leave })
            .child(
                ScrollArea::new("library-saved-scroll")
                    .max_height(MaxHeight::Sm)
                    .child(Stack::new().gap(Space::Xs).children(rows)),
            )
            .child(if self.busy { new.disabled() } else { new });
        let form = DialogForm::new(copy.add_to_group).child(body);
        let me = cx.weak_entity();
        shell(
            ("library-saved-dialog", cx.entity_id()),
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
