//! `CanonInlineDraft.tsx`, `useEpicInlineEdit.ts`, `useInlineExitGuard.ts` and
//! `InlineUnsavedDialog.tsx`: the one inline title or description edit, and the decision a
//! leaving navigation waits on while the edit is unsaved.
use gpui::ParentElement as _;
use std::rc::Rc;

use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::dialog::{Dialog, DialogContent, Size as DialogSize};
use butler_ds::ui::layout::Justify;
use gpui::{AnyElement, App, ClickEvent, Context, IntoElement as _, SharedString, Window};

use super::attach::AttachedFile;
use super::inspector::{Done, EpicInspector};
use crate::ui::manage::{LeaveGuard, Proceed};
use crate::ui::source::wire::{EpicDetail, EpicInput};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TextField {
    Title,
    Description,
}

impl TextField {
    pub(super) fn of(self, epic: &EpicDetail) -> &str {
        match self {
            Self::Title => &epic.card.title,
            Self::Description => &epic.card.description,
        }
    }
}

/// `InlineDraft`
pub(super) struct Draft {
    pub(super) field: TextField,
    pub(super) value: String,
    pub(super) base: EpicDetail,
    pub(super) revision: i64,
    /// The epic as someone else saved it, once a conflict was told.
    pub(super) current: Option<EpicDetail>,
}

/// What the owner decided about an unsaved edit.
#[derive(Clone, Copy)]
pub(super) enum Choice {
    Keep,
    Discard,
    Save,
}

#[derive(Default)]
pub(super) struct Inline {
    pub(super) draft: Option<Draft>,
    failed: Option<i64>,
    /// `pendingFile`: the name of the file being uploaded.
    pub(super) uploading: Option<SharedString>,
    pub(super) files: Vec<AttachedFile>,
    /// The leaves waiting on the unsaved dialog; `Some` while it is open.
    prompt: Option<Vec<Proceed>>,
    /// The field takes the keyboard on the next render.
    pub(super) refocus: bool,
}

impl Inline {
    pub(super) fn guard_open(&self) -> bool {
        self.prompt.is_some()
    }

    pub(super) fn dirty(&self) -> bool {
        self.draft
            .as_ref()
            .is_some_and(|draft| draft.value != draft.field.of(&draft.base))
            || self.uploading.is_some()
    }

    /// A title cannot be blank.
    pub(super) fn valid(&self) -> bool {
        self.draft
            .as_ref()
            .is_none_or(|draft| draft.field != TextField::Title || !draft.value.trim().is_empty())
    }
}

impl EpicInspector {
    /// `begin`: leaving a draft of the other field first.
    pub(super) fn begin_edit(
        &mut self,
        field: TextField,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.inline.draft.is_none() {
            self.start_draft(field, cx);
            return;
        }
        let me = cx.weak_entity();
        let proceed: Proceed = Box::new(move |_, cx| {
            let _ = me.update(cx, |this, cx| this.start_draft(field, cx));
        });
        self.leave(proceed, window, cx);
    }

    fn start_draft(&mut self, field: TextField, cx: &mut Context<Self>) {
        let Some(base) = self.detail.clone() else {
            return;
        };
        self.inline.draft = Some(Draft {
            field,
            value: field.of(&base).to_owned(),
            revision: base.card.revision,
            base,
            current: None,
        });
        self.inline.refocus = true;
        let me = cx.weak_entity();
        let guard: LeaveGuard = Rc::new(move |proceed, window, cx| {
            let _ = me.update(cx, |this, cx| this.leave(proceed, window, cx));
        });
        self.ctx.set_leave_guard(Some(guard), cx);
        cx.notify();
    }

    /// `change`
    pub(super) fn change_edit(&mut self, value: String, cx: &mut Context<Self>) {
        if let Some(draft) = self.inline.draft.as_mut().filter(|d| d.value != value) {
            draft.value = value;
            cx.notify();
        }
    }

    /// `cancel`
    pub(super) fn cancel_edit(&mut self, cx: &mut Context<Self>) {
        self.inline.failed = None;
        self.inline.draft = None;
        self.inline.refocus = true;
        self.ctx.set_leave_guard(None, cx);
        cx.notify();
    }

    /// Once the epic was read at a newer revision than the failed save, the draft shows what
    /// is there now and writes against it.
    pub(super) fn sync_draft(&mut self, epic: &EpicDetail) {
        let Some(failed) = self.inline.failed.filter(|r| epic.card.revision > *r) else {
            return;
        };
        if let Some(draft) = self
            .inline
            .draft
            .as_mut()
            .filter(|d| d.base.card.id == epic.card.id && d.revision == failed)
        {
            draft.current = Some(epic.clone());
            draft.revision = epic.card.revision;
        }
        self.inline.failed = None;
    }

    /// `save`: nothing changed closes the draft; a failed write keeps it.
    pub(super) fn save_edit(&mut self, done: Option<Done>, cx: &mut Context<Self>) {
        let answer = |done: Option<Done>, saved, this: &mut Self, cx: &mut Context<Self>| {
            if let Some(done) = done {
                done(saved, this, cx);
            }
        };
        let busy = self.busy || self.inline.uploading.is_some();
        let Some(draft) = self.inline.draft.as_ref().filter(|_| !busy) else {
            answer(done, false, self, cx);
            return;
        };
        if !self.inline.valid() {
            answer(done, false, self, cx);
            return;
        }
        if !self.inline.dirty() {
            self.cancel_edit(cx);
            answer(done, true, self, cx);
            return;
        }
        let (field, revision) = (draft.field, draft.revision);
        let mut input = EpicInput {
            expected_revision: Some(revision),
            ..EpicInput::default()
        };
        match field {
            TextField::Title => input.title = Some(draft.value.trim().to_owned()),
            TextField::Description => input.description = Some(draft.value.clone()),
        }
        let saved = SharedString::from(Self::words(cx).saved);
        self.write(
            input,
            Some(saved),
            Some(Box::new(move |saved, this, cx| {
                if saved {
                    this.cancel_edit(cx);
                } else {
                    this.inline.failed = Some(revision);
                }
                answer(done, saved, this, cx);
            })),
            cx,
        );
    }

    // CARVE-OUT(G-ds): React also leaves on a focus-out of the editor (`guard.blur`), and
    // `focusTitle` focuses the title; the DS fields and Clickable report no blur and expose no
    // focus handle, so only navigation, Escape, ✓ and × leave an edit.
    /// `leave`: `proceed` runs now when nothing is unsaved, else after the owner decides.
    pub(super) fn leave(&mut self, proceed: Proceed, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(waiting) = self.inline.prompt.as_mut() {
            waiting.push(proceed);
            return;
        }
        if self.inline.draft.is_some() && self.inline.dirty() {
            self.inline.prompt = Some(vec![proceed]);
            cx.notify();
            return;
        }
        self.cancel_edit(cx);
        window.defer(cx, proceed);
    }

    /// `decide`
    pub(super) fn decide(&mut self, choice: Choice, window: &mut Window, cx: &mut Context<Self>) {
        match choice {
            Choice::Keep => {
                self.inline.prompt = None;
                self.inline.refocus = true;
                cx.notify();
            }
            Choice::Discard => {
                self.cancel_edit(cx);
                self.release(window, cx);
            }
            Choice::Save => {
                let handle = window.window_handle();
                self.save_edit(
                    Some(Box::new(move |saved, this, cx| {
                        if saved {
                            let waiting = this.inline.prompt.take().unwrap_or_default();
                            cx.notify();
                            let _ = handle.update(cx, move |_, window, cx| {
                                for proceed in waiting {
                                    window.defer(cx, proceed);
                                }
                            });
                        }
                    })),
                    cx,
                );
            }
        }
    }

    /// The leaves that waited on the decision go on.
    fn release(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for proceed in self.inline.prompt.take().unwrap_or_default() {
            window.defer(cx, proceed);
        }
        cx.notify();
    }

    /// `InlineUnsavedDialog`
    pub(super) fn unsaved_dialog(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        self.inline.prompt.as_ref()?;
        let words = Self::words(cx);
        let (busy, valid) = (self.busy, self.inline.valid());
        let owner = cx.entity();
        let choose = move |choice: Choice| {
            let owner = owner.clone();
            move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                owner.update(cx, |this, cx| this.decide(choice, window, cx));
            }
        };
        let mut keep = Button::new("canon-unsaved-keep")
            .size(Size::Sm)
            .variant(Variant::Ghost)
            .text(words.keep)
            .on_click(choose(Choice::Keep));
        let mut discard = Button::new("canon-unsaved-discard")
            .size(Size::Sm)
            .variant(Variant::Ghost)
            .text(words.discard)
            .on_click(choose(Choice::Discard));
        let mut save = Button::new("canon-unsaved-save")
            .size(Size::Sm)
            .text(words.save)
            .on_click(choose(Choice::Save));
        if busy {
            (keep, discard) = (keep.disabled(), discard.disabled());
        }
        if busy || !valid {
            save = save.disabled();
        }
        let footer = button::container(Size::Sm)
            .justify(Justify::End)
            .child(keep)
            .child(discard)
            .child(save);
        let me = cx.weak_entity();
        Some(
            Dialog::new("canon-unsaved-dialog", window, cx)
                .open(true)
                .modal(true)
                .on_open_change(move |open, window, cx| {
                    if !open && !busy {
                        let _ = me.update(cx, |this, cx| this.decide(Choice::Keep, window, cx));
                    }
                })
                .content(
                    DialogContent::new()
                        .size(DialogSize::Sm)
                        .child(DialogForm::new(words.unsaved).footer(footer)),
                    window,
                    cx,
                )
                .into_any_element(),
        )
    }
}
