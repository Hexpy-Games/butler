//! `library/LibraryDialogHost.tsx`, `libraryDialogs.ts`: the 서랍's dialogs; one host renders
//! whichever is open, from any screen. The pieces the dialogs share (the DS dialog shell, the
//! capped text field, the footer) live here too.
use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::dialog::{Dialog, DialogContent, Size as DialogSize};
use butler_ds::ui::layout::Justify;
use butler_ds::ui::text::{self, Input};
use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Context, ElementId, Empty, Entity, EntityId,
    EventEmitter, Focusable as _, IntoElement, ParentElement as _, Render, SharedString,
    Subscription, Window,
};

use super::delete::DeleteItems;
use super::group::GroupDialog;
use super::item_tags::ItemTags;
use super::saved::SavedChooser;
use super::tags::ManageTags;
use crate::ui::manage::library::types::{LibraryGroup, LibraryItem};
use crate::ui::manage::{LibraryKind, ManageCtx, Pick};

/// `LibraryDialogState`: the 서랍's dialogs.
pub(crate) enum LibraryDialog {
    /// Tag management.
    Tags,
    CreateGroup {
        kind: LibraryKind,
        then: Option<Pick<LibraryGroup>>,
    },
    RenameGroup(LibraryGroup),
    Ungroup(LibraryGroup),
    /// Move items into a group of their kind.
    Move {
        kind: LibraryKind,
        items: Vec<LibraryItem>,
    },
    /// Tags of one item, or of several (bulk).
    TagItems(Vec<LibraryItem>),
    DeleteItems(Vec<LibraryItem>),
    /// Scraps just saved from the browser: put them in a group (shown beside the sidebar's 서랍
    /// row).
    Saved {
        ids: Vec<String>,
        beside: bool,
    },
}

/// What a dialog tells the host.
pub(super) enum DialogEvent {
    Closed,
    /// A tag was renamed (`to`) or deleted (`None`): the page's tag filter follows.
    TagChanged {
        from: SharedString,
        to: Option<SharedString>,
    },
}

/// What the host tells the 서랍 page.
pub(crate) enum LibraryDialogsEvent {
    /// `setFilters` of `ManageTagsDialog`: a filter on `from` becomes `to`, or goes.
    TagChanged {
        from: SharedString,
        to: Option<SharedString>,
    },
}

enum Active {
    Group(Entity<GroupDialog>),
    Tags(Entity<ManageTags>),
    Items(Entity<ItemTags>),
    Delete(Entity<DeleteItems>),
    Saved(Entity<SavedChooser>),
}

impl Active {
    fn id(&self) -> EntityId {
        match self {
            Self::Group(dialog) => dialog.entity_id(),
            Self::Tags(dialog) => dialog.entity_id(),
            Self::Items(dialog) => dialog.entity_id(),
            Self::Delete(dialog) => dialog.entity_id(),
            Self::Saved(dialog) => dialog.entity_id(),
        }
    }

    fn element(&self) -> AnyElement {
        match self {
            Self::Group(dialog) => dialog.clone().into_any_element(),
            Self::Tags(dialog) => dialog.clone().into_any_element(),
            Self::Items(dialog) => dialog.clone().into_any_element(),
            Self::Delete(dialog) => dialog.clone().into_any_element(),
            Self::Saved(dialog) => dialog.clone().into_any_element(),
        }
    }
}

/// `LibraryDialogHost`: one for the window, made by [`super::install`] and rendered by the shell,
/// so picks can be filed (and the sidebar's drop dwell answered) while the 서랍 page is closed.
pub(crate) struct LibraryDialogs {
    ctx: ManageCtx,
    active: Option<Active>,
    watching: Option<Subscription>,
}

impl EventEmitter<LibraryDialogsEvent> for LibraryDialogs {}

impl LibraryDialogs {
    pub(super) fn new(ctx: ManageCtx) -> Self {
        Self {
            ctx,
            active: None,
            watching: None,
        }
    }

    pub(crate) fn open(&mut self, dialog: LibraryDialog, cx: &mut Context<Self>) {
        let ctx = self.ctx.clone();
        let active = match dialog {
            LibraryDialog::Tags => Active::Tags(cx.new(|cx| ManageTags::new(&ctx, cx))),
            LibraryDialog::CreateGroup { kind, then } => {
                Active::Group(cx.new(|cx| GroupDialog::create(ctx, kind, then, cx)))
            }
            LibraryDialog::RenameGroup(group) => {
                Active::Group(cx.new(|cx| GroupDialog::rename(ctx, group, cx)))
            }
            LibraryDialog::Ungroup(group) => {
                Active::Group(cx.new(|cx| GroupDialog::ungroup(ctx, group, cx)))
            }
            LibraryDialog::Move { kind, items } => {
                Active::Group(cx.new(|cx| GroupDialog::move_items(ctx, kind, items, cx)))
            }
            LibraryDialog::TagItems(items) => {
                Active::Items(cx.new(|cx| ItemTags::new(ctx, items, cx)))
            }
            LibraryDialog::DeleteItems(items) => {
                Active::Delete(cx.new(|_| DeleteItems::new(items)))
            }
            LibraryDialog::Saved { ids, .. } => {
                Active::Saved(cx.new(|cx| SavedChooser::new(ctx, ids, cx)))
            }
        };
        self.watching = Some(match &active {
            Active::Group(dialog) => Self::watch(dialog, cx),
            Active::Tags(dialog) => Self::watch(dialog, cx),
            Active::Items(dialog) => Self::watch(dialog, cx),
            Active::Delete(dialog) => Self::watch(dialog, cx),
            Active::Saved(dialog) => Self::watch(dialog, cx),
        });
        self.active = Some(active);
        cx.notify();
    }

    fn watch<T: EventEmitter<DialogEvent>>(
        dialog: &Entity<T>,
        cx: &mut Context<Self>,
    ) -> Subscription {
        cx.subscribe(
            dialog,
            |this, dialog, event: &DialogEvent, cx| match event {
                DialogEvent::Closed => {
                    // A dialog that opened another one has already been replaced.
                    if this
                        .active
                        .as_ref()
                        .is_some_and(|a| a.id() == dialog.entity_id())
                    {
                        this.active = None;
                        this.watching = None;
                        cx.notify();
                    }
                }
                DialogEvent::TagChanged { from, to } => cx.emit(LibraryDialogsEvent::TagChanged {
                    from: from.clone(),
                    to: to.clone(),
                }),
            },
        )
    }
}

impl Render for LibraryDialogs {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.active
            .as_ref()
            .map_or_else(|| Empty.into_any_element(), Active::element)
    }
}

/// The DS dialog around `form`; closing it (Escape, the scrim) asks `on_close` unless `busy`.
pub(super) fn shell(
    id: impl Into<ElementId>,
    form: DialogForm,
    busy: bool,
    on_close: impl Fn(&mut Window, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let dialog = Dialog::new(id, window, cx)
        .open(true)
        .on_open_change(move |open, window, cx| {
            if !open && !busy {
                on_close(window, cx);
            }
        });
    dialog.content(
        DialogContent::new().size(DialogSize::Sm).child(form),
        window,
        cx,
    )
}

/// The footer of a dialog: cancel first, the primary last.
pub(super) fn footer(
    id: &'static str,
    cancel: (
        &'static str,
        impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ),
    submit: (
        &'static str,
        impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ),
    busy: bool,
    blocked: bool,
) -> impl IntoElement {
    let mut cancel_button = Button::new(SharedString::from(format!("{id}-cancel")))
        .size(Size::Sm)
        .variant(Variant::Ghost)
        .text(cancel.0)
        .on_click(cancel.1);
    let mut submit_button = Button::new(SharedString::from(format!("{id}-submit")))
        .size(Size::Sm)
        .text(submit.0)
        .on_click(submit.1);
    if busy {
        cancel_button = cancel_button.disabled();
    }
    if busy || blocked {
        submit_button = submit_button.disabled();
    }
    button::container(Size::Sm)
        .justify(Justify::End)
        .child(cancel_button)
        .child(submit_button)
}

/// A single-line field showing `value`, kept to `max` characters; `changed` hears the kept text.
pub(super) fn text_field(
    id: impl Into<ElementId>,
    value: &SharedString,
    max: usize,
    window: &mut Window,
    cx: &mut App,
    changed: impl Fn(SharedString, &mut App) + 'static,
) -> Input {
    let id: ElementId = id.into();
    let state = text::state(id.clone(), window, cx);
    Input::new(id)
        .value(value.clone())
        .on_change(move |text, _, cx| {
            let kept: String = text.chars().take(max).collect();
            if kept != text {
                state.update(cx, |state, cx| state.emplace(&kept, cx));
            }
            changed(kept.into(), cx);
        })
}

/// Focuses the field `id` the first time it is asked (`autoFocus`).
pub(super) fn focus_once(
    id: impl Into<ElementId>,
    done: &mut bool,
    window: &mut Window,
    cx: &mut App,
) {
    if std::mem::replace(done, true) {
        return;
    }
    let handle = text::state(id, window, cx).read(cx).focus_handle(cx);
    handle.focus(window, cx);
}
