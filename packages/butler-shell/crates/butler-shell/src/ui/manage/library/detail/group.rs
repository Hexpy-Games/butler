//! `library/GroupDialog.tsx`: create, rename, ungroup a group (a bookmark folder), or move items
//! into one.
use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::select::{Select, SelectContent, SelectGroup, SelectItem, SelectTrigger};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::Typo;
use butler_shell_client::Error;
use gpui::{
    AnyElement, App, ClickEvent, Context, EventEmitter, InteractiveElement as _, IntoElement,
    KeyDownEvent, ParentElement as _, Render, SharedString, WeakEntity, Window, div,
};

use super::api::{ItemsPatch, create_group, delete_group, load_groups, patch_items, rename_group};
use super::copy::words;
use super::dialogs::{DialogEvent, focus_once, footer, shell, text_field};
use crate::ui::manage::library::types::{LibraryGroup, LibraryItem};
use crate::ui::manage::{LibraryKind, LibraryView, ManageCtx, Pick, View};
use crate::ui::widgets::anchor;

const NEW: &str = "__new";
const NONE: &str = "none";
/// `maxLength` of the name field.
const NAME_MAX: usize = 80;

enum Mode {
    Create(Option<Pick<LibraryGroup>>),
    Rename(LibraryGroup),
    Ungroup(LibraryGroup),
    Move(Vec<LibraryItem>),
}

pub(super) struct GroupDialog {
    ctx: ManageCtx,
    kind: LibraryKind,
    mode: Mode,
    name: SharedString,
    target: SharedString,
    groups: Vec<LibraryGroup>,
    busy: bool,
    error: Option<&'static str>,
    focused: bool,
}

impl EventEmitter<DialogEvent> for GroupDialog {}

impl GroupDialog {
    fn with(ctx: ManageCtx, kind: LibraryKind, mode: Mode, name: String) -> Self {
        Self {
            ctx,
            kind,
            mode,
            name: name.into(),
            target: NONE.into(),
            groups: Vec::new(),
            busy: false,
            error: None,
            focused: false,
        }
    }

    pub(super) fn create(
        ctx: ManageCtx,
        kind: LibraryKind,
        then: Option<Pick<LibraryGroup>>,
        _cx: &mut Context<Self>,
    ) -> Self {
        Self::with(ctx, kind, Mode::Create(then), String::new())
    }

    pub(super) fn rename(ctx: ManageCtx, group: LibraryGroup, _cx: &mut Context<Self>) -> Self {
        let (kind, name) = (group.kind, group.name.clone());
        Self::with(ctx, kind, Mode::Rename(group), name)
    }

    pub(super) fn ungroup(ctx: ManageCtx, group: LibraryGroup, _cx: &mut Context<Self>) -> Self {
        let (kind, name) = (group.kind, group.name.clone());
        Self::with(ctx, kind, Mode::Ungroup(group), name)
    }

    pub(super) fn move_items(
        ctx: ManageCtx,
        kind: LibraryKind,
        items: Vec<LibraryItem>,
        cx: &mut Context<Self>,
    ) -> Self {
        load_groups(cx, kind, |this: &mut Self, groups, _| {
            this.groups = groups;
            true
        });
        Self::with(ctx, kind, Mode::Move(items), String::new())
    }

    fn naming(&self) -> bool {
        match self.mode {
            Mode::Create(_) | Mode::Rename(_) => true,
            Mode::Move(_) => &*self.target == NEW,
            Mode::Ungroup(_) => false,
        }
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        if self.busy || (self.naming() && self.name.trim().is_empty()) {
            return;
        }
        self.busy = true;
        self.error = None;
        cx.notify();
        let me = cx.weak_entity();
        let name = self.name.trim().to_owned();
        match &self.mode {
            Mode::Move(items) => {
                let ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
                if &*self.target == NEW {
                    create_group(cx, self.kind, &name, move |result, cx| match result {
                        Ok(group) => move_into(ids, Some(group.id), me, cx),
                        Err(error) => report(&me, Err(error), None, cx),
                    });
                } else {
                    let group = (&*self.target != NONE).then(|| self.target.to_string());
                    move_into(ids, group, me, cx);
                }
            }
            Mode::Ungroup(group) => {
                delete_group(cx, group.id.clone(), move |result, cx| {
                    report(&me, result.map(|_| ()), None, cx);
                });
            }
            Mode::Rename(group) => {
                rename_group(cx, group.id.clone(), &name, move |result, cx| {
                    report(&me, result.map(|_| ()), None, cx);
                });
            }
            Mode::Create(_) => create_group(cx, self.kind, &name, move |result, cx| match result {
                Ok(group) => report(&me, Ok(()), Some(group), cx),
                Err(error) => report(&me, Err(error), None, cx),
            }),
        }
    }

    /// The write answered: success closes; a failure stays with its message.
    fn finished(
        &mut self,
        result: Result<(), Error>,
        created: Option<LibraryGroup>,
        cx: &mut Context<Self>,
    ) {
        self.busy = false;
        match result {
            Ok(()) => {
                self.succeeded(created, cx);
                cx.emit(DialogEvent::Closed);
            }
            Err(error) => {
                let copy = words(Ds::get(cx).lang());
                // The server answers a taken name with a conflict (G-codes: by status only).
                let message = if matches!(error, Error::Http(409)) {
                    copy.group_exists
                } else {
                    copy.failed
                };
                self.error = Some(message);
                toast::show(cx, Toast::error(message));
            }
        }
        cx.notify();
    }

    fn succeeded(&mut self, created: Option<LibraryGroup>, cx: &mut Context<Self>) {
        match &self.mode {
            Mode::Ungroup(group) => {
                let showing = matches!(self.ctx.view(cx),
                    View::Library(view) if view.group.as_deref() == Some(group.id.as_str()));
                if showing {
                    let view = LibraryView {
                        section: Some(self.kind),
                        ..LibraryView::default()
                    };
                    self.ctx.set_view(View::Library(view), cx);
                }
            }
            Mode::Create(Some(then)) => {
                let (then, created) = (then.clone(), created);
                if let (Some(group), Some(window)) = (created, cx.active_window()) {
                    let _ = window.update(cx, |_, window, cx| then(group, window, cx));
                }
            }
            _ => {}
        }
    }

    fn body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let copy = words(Ds::get(cx).lang());
        let kind = copy.group(self.kind);
        let me = cx.weak_entity();
        let mut body = Vec::new();
        if let Mode::Ungroup(group) = &self.mode {
            body.push(Typo::text((kind.ungroup_body)(group.count)).into_any_element());
        }
        if matches!(self.mode, Mode::Move(_)) {
            body.push(self.target_select(window, cx));
        }
        if self.naming() {
            let id = ("library-group-name", cx.entity_id());
            focus_once(id, &mut self.focused, window, cx);
            let input = text_field(id, &self.name, NAME_MAX, window, cx, move |name, cx| {
                let _ = me.update(cx, |this, cx| {
                    this.name = name;
                    cx.notify();
                });
            });
            let submit = cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "enter" {
                    cx.stop_propagation();
                    this.submit(cx);
                }
            });
            body.push(
                div()
                    .capture_key_down(submit)
                    .child(input)
                    .into_any_element(),
            );
        }
        if let Some(message) = self.error {
            body.push(EmptyLine::new(message).into_any_element());
        }
        body
    }

    fn target_select(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let copy = words(Ds::get(cx).lang()).group(self.kind);
        let me = cx.weak_entity();
        let select = Select::new("library-group-target", window, cx)
            .value(Some(self.target.clone()))
            .on_value_change(move |value, _, cx| {
                let _ = me.update(cx, |this, cx| {
                    this.target = value;
                    cx.notify();
                });
            });
        let mut group = SelectGroup::new().child(SelectItem::new(NONE, copy.ungrouped));
        for item in &self.groups {
            group = group.child(SelectItem::new(item.id.clone(), item.name.clone()));
        }
        group = group.child(SelectItem::new(NEW, copy.new_group));
        let content = SelectContent::new().child(group);
        let trigger = select.trigger(
            SelectTrigger::new("library-group-target-trigger"),
            &content,
            cx,
        );
        let list = select.content(&content, window, cx);
        div().child(trigger).child(list).into_any_element()
    }
}

/// `patchItems({ ids, group })` for a move.
fn move_into(ids: Vec<String>, group: Option<String>, me: WeakEntity<GroupDialog>, cx: &mut App) {
    let patch = ItemsPatch {
        ids,
        group: Some(group),
        ..ItemsPatch::default()
    };
    patch_items(cx, patch, move |result, cx| {
        report(&me, result.map(|_| ()), None, cx);
    });
}

fn report(
    me: &WeakEntity<GroupDialog>,
    result: Result<(), Error>,
    created: Option<LibraryGroup>,
    cx: &mut App,
) {
    let _ = me.update(cx, |this, cx| this.finished(result, created, cx));
}

impl Render for GroupDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let kind = copy.group(self.kind);
        let title = match &self.mode {
            Mode::Move(_) => kind.move_to.to_owned(),
            Mode::Ungroup(group) => (kind.ungroup_title)(&group.name),
            Mode::Rename(_) => kind.rename_group.to_owned(),
            Mode::Create(_) => kind.create_group.to_owned(),
        };
        let submit_text = match &self.mode {
            Mode::Move(_) => copy.move_items,
            Mode::Ungroup(_) => kind.ungroup,
            Mode::Rename(_) => copy.save,
            Mode::Create(_) => copy.create,
        };
        let blocked = self.naming() && self.name.trim().is_empty();
        let cancel = cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(DialogEvent::Closed));
        let submit = cx.listener(|this, _: &ClickEvent, _, cx| this.submit(cx));
        let body = self.body(window, cx);
        let form = DialogForm::new(title)
            .footer(footer(
                "library-group",
                (copy.cancel, cancel),
                (submit_text, submit),
                self.busy,
                blocked,
            ))
            .child(
                anchor(div(), "library-group-dialog")
                    .child(Stack::new().gap(Space::Sm).children(body)),
            );
        let me = cx.weak_entity();
        shell(
            ("library-group-dialog", cx.entity_id()),
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
